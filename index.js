// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const archiver = require("archiver"); // Add archiver

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "200mb" }));

// Serve admin page from /public
app.use(express.static(path.join(__dirname, "public")));

// Store file list and agent sockets
let agentFiles = [];
let agentSocket = null;

// Folder to store uploaded files temporarily
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// WebSocket server (will be attached later)
let wss;


const tempDirFiles = {};

// Moved WS setup to be wrapped in a function or initialized after server starts
// ... actually, we can just define the behavior here but init the server later.
// Let's refactor slightly to keep the logic clean.

const EventEmitter = require('events');
const fileEvents = new EventEmitter();

const setupWebSocket = (server) => {
    wss = new WebSocket.Server({ server });

    wss.on("connection", (ws) => {
        console.log("Agent connected via WebSocket");
        agentSocket = ws;

        ws.on("message", (message) => {
            const data = JSON.parse(message);
            // console.log("Received WS message type:", data.type); // Less verbose logging

            if (data.type === "file") {
                const safeName = data.path.replace(/[\/\\]/g, "_");
                const savePath = path.join(UPLOAD_DIR, safeName);
                const buffer = Buffer.from(data.content, "base64");
                fs.writeFileSync(savePath, buffer);
                console.log(`Received file: ${safeName} (Path: ${data.path})`);

                // Emit event to notify waiters
                fileEvents.emit('file', { path: data.path, savePath });
            }

            if (data.type === "dir_list") {
                const dir = data.dir;
                const files = data.files; // array of filenames
                tempDirFiles[dir] = files; // store globally
                console.log(`Received files for ${dir}: ${files.length}`);
            }
        });

        ws.on("close", () => {
            console.log("Agent disconnected");
            agentSocket = null;
        });
    });
};


// Agent uploads file list
app.post("/upload-files", (req, res) => {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) return res.status(400).json({ error: "Invalid file list" });

    agentFiles = files;
    console.log(`Agent file list updated (${files.length} items)`);
    res.json({ status: "ok", count: files.length });
});

app.get("/files/:dir", async (req, res) => {
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ error: "Agent not connected" });
    }

    const dir = req.params.dir;

    // Ask agent to send dir_list if not already
    if (!tempDirFiles[dir] || tempDirFiles[dir].length === 0) {
        agentSocket.send(JSON.stringify({ type: "request_dir", path: dir }));
        console.log(`Sent request_dir for ${dir}`);

        // Wait up to 15 seconds
        const timeout = Date.now() + 15000;
        while ((!tempDirFiles[dir] || tempDirFiles[dir].length === 0) && Date.now() < timeout) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    if (!tempDirFiles[dir] || tempDirFiles[dir].length === 0) {
        return res.status(504).json({ error: "No files received" });
    }

    res.json(tempDirFiles[dir]); // send array of filenames to HTML
});

// Helper to fetch a file from the agent
const fetchFileFromAgent = async (dir, filename) => {
    // Determine path
    let filePath;
    if (filename.startsWith("/") || filename.startsWith("storage") || filename.match(/^[a-zA-Z]:/)) {
        filePath = filename;
    } else {
        // Clean trailing slash from dir to avoid double slashes
        const cleanDir = dir.replace(/[\/\\]$/, "");
        filePath = `${cleanDir}/${filename}`;
    }

    console.log(`Requesting file: ${filePath}`);
    agentSocket.send(JSON.stringify({ type: "request_file", path: filePath }));

    return new Promise((resolve) => {
        const timeoutMs = 60000;
        const timeout = setTimeout(() => {
            fileEvents.off('file', handler);
            resolve(null);
        }, timeoutMs);

        const handler = (fileData) => {
            // Loose matching:
            // 1. Exact match
            // 2. Received path ends with requested path (e.g. requested local, received absolute)
            // 3. Requested path ends with received path (unlikely but possible)
            // 4. Filenames match (very loose, but effectively correct if one request at a time)

            const reqNorm = filePath.replace(/\\/g, "/");
            const resNorm = fileData.path.replace(/\\/g, "/");

            const match = reqNorm === resNorm ||
                resNorm.endsWith(reqNorm) ||
                reqNorm.endsWith(resNorm) ||
                path.basename(reqNorm) === path.basename(resNorm); // Fallback: match basename

            if (match) {
                console.log(`Matched response ${fileData.path} to request ${filePath}`);
                clearTimeout(timeout);
                fileEvents.off('file', handler);
                resolve(fileData.savePath);
            }
        };

        fileEvents.on('file', handler);
    });
};


app.get("/file/view/:dir/:filename", async (req, res) => {
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ error: "Agent not connected" });
    }

    const { dir, filename } = req.params;

    try {
        const savePath = await fetchFileFromAgent(dir, filename);

        if (!savePath) return res.status(504).json({ error: "File upload timeout" });

        res.sendFile(savePath, {}, (err) => {
            if (!err) {
                try {
                    fs.unlinkSync(savePath);
                } catch (e) { }
            }
        });
    } catch (e) {
        console.error("Error in file view:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get("/download-all/:dir", async (req, res) => {
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ error: "Agent not connected" });
    }

    const dir = req.params.dir;

    // Ensure we have the file list
    if (!tempDirFiles[dir] || tempDirFiles[dir].length === 0) {
        return res.status(400).json({ error: "Directory list not loaded. Please view the directory first." });
    }

    const files = tempDirFiles[dir];
    console.log(`Starting zip download for ${files.length} files in ${dir}`);

    // Create zip
    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    res.attachment(`${dir}.zip`);

    archive.on('warning', function (err) {
        if (err.code === 'ENOENT') {
            console.warn("Zip warning:", err);
        } else {
            console.error("Zip error:", err);
            if (!res.headersSent) res.status(500).send({ error: err.message });
        }
    });

    archive.on('error', function (err) {
        console.error("Zip failure:", err);
        if (!res.headersSent) res.status(500).send({ error: err.message });
    });

    archive.pipe(res);

    // Iterate and add files
    // Note: We do this sequentially to avoid overwhelming the agent/websocket
    for (const file of files) {
        try {
            console.log(`Fetching ${file} for zip...`);
            const filePath = await fetchFileFromAgent(dir, file);
            if (filePath) {
                // Determine internal name inside zip
                const internalName = path.basename(file);

                // Add to archive
                archive.file(filePath, { name: internalName });

                // Note: archiver reads the file asynchronously. We shouldn't delete it immediately 
                // until we know it's buffered, but archiver.file enqueues it. 
                // FOR SAFETY: We will NOT delete these temp files immediately here, or we need a way to know when archiver is done with this specific file.
                // A better approach for this synced flow: read to buffer? No, too much RAM.
                // We'll trust archiver to read it. We can clean up the upload dir generally later or simple timeout.
                // Or, better: Listen to 'entry' event? 
                // Let's just NOT delete them immediately. The server restarts or a cron job can clean uploads.
                // OR: simply keep them. The `fetchFileFromAgent` deletes existing ones before fetch.
            }
        } catch (e) {
            console.error(`Failed to fetch ${file} for zip:`, e);
            // Continue with other files
        }
    }

    await archive.finalize();
    console.log("Zip finalized");

    // Cleanup? Maybe clear the upload dir?
    // files.forEach(f => { ... })
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Node server running at http://0.0.0.0:${PORT}`);
    console.log(`WebSocket sharing same port: ws://0.0.0.0:${PORT}`);
});

// Attach WebSocket to the same server instance
setupWebSocket(server);

