// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

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

const setupWebSocket = (server) => {
    wss = new WebSocket.Server({ server });

    wss.on("connection", (ws) => {
        console.log("Agent connected via WebSocket");
        agentSocket = ws;

        ws.on("message", (message) => {
            const data = JSON.parse(message);
            console.log("Received WS message:", data);

            if (data.type === "file") {
                const safeName = data.path.replace(/[\/\\]/g, "_");
                const savePath = path.join(UPLOAD_DIR, safeName);
                const buffer = Buffer.from(data.content, "base64");
                fs.writeFileSync(savePath, buffer);
                console.log(`Received file: ${safeName}`);
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



app.get("/file/view/:dir/:filename", async (req, res) => {
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ error: "Agent not connected" });
    }

    const { dir, filename } = req.params;

    // Determine path: if filename looks absolute (Android), use it directly. Otherwise use dir/filename
    // Common Android paths start with /storage or storage
    let filePath;
    if (filename.startsWith("/") || filename.startsWith("storage") || filename.match(/^[a-zA-Z]:/)) {
        filePath = filename;
    } else {
        filePath = `${dir}/${filename}`;
    }
    const safeName = filePath.replace(/[\/\\]/g, "_");
    const savePath = path.join(UPLOAD_DIR, safeName);


    if (fs.existsSync(savePath)) fs.unlinkSync(savePath);

    agentSocket.send(JSON.stringify({ type: "request_file", path: filePath }));

    const checkFile = () => fs.existsSync(savePath);
    const waitForFile = async () => {
        const timeout = Date.now() + 15000;
        while (!checkFile() && Date.now() < timeout) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (!checkFile()) return null;
        return savePath;
    };

    const result = await waitForFile();
    if (!result) return res.status(504).json({ error: "File upload timeout" });

    res.sendFile(savePath, {}, (err) => {
        if (!err) fs.unlinkSync(savePath); // Delete after sending
    });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Node server running at http://0.0.0.0:${PORT}`);
    console.log(`WebSocket sharing same port: ws://0.0.0.0:${PORT}`);
});

// Attach WebSocket to the same server instance
setupWebSocket(server);

