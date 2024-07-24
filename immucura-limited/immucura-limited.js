import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY;
const API_URL = 'https://api.monday.com/v2';
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOAD_DIR = path.join(__dirname, 'files-uploaded');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR);
}

const logs = [];
let logListeners = [];

const addLog = (log) => {
    const formattedLog = JSON.stringify(log, null, 2).replace(/\n/g, '<br>').replace(/ /g, '&nbsp;');
    logs.push(formattedLog);
    if (logs.length > 100) logs.shift();
    logListeners.forEach(listener => listener(formattedLog));
};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    logs.forEach(log => res.write(`data: ${log}\n\n`));

    const sendLog = (log) => res.write(`data: ${log}\n\n`);

    logListeners.push(sendLog);

    req.on('close', () => {
        logListeners = logListeners.filter(listener => listener !== sendLog);
    });
});

app.post('/webhook', async (req, res) => {
    const event = req.body.event;
    addLog({ message: 'Webhook received', data: req.body });

    if (req.body.challenge) {
        addLog({ message: 'Responding to webhook challenge', challenge: req.body.challenge });
        return res.status(200).json({ challenge: req.body.challenge });
    }

    try {
        if (event && event.type === 'create_pulse') {
            const email = event.columnValues?.e_mail__1?.email;
            const files = event.columnValues?.upload_file__1?.files;

            if (email && files && files.length > 0) {
                addLog({ message: 'Email and files found in create_pulse event', email, files });

                for (const file of files) {
                    const assetId = file.assetId;
                    const fileName = file.name;
                    try {
                        const fileUrl = await getPublicUrl(assetId);
                        addLog({ message: 'Public URL obtained', fileUrl });
                        const filePath = await downloadFile(fileUrl, fileName);

                        await processFileUpload(email, filePath);
                    } catch (error) {
                        addLog({ message: 'Error getting public URL or downloading the file', error });
                    }
                }
            } else {
                addLog({ message: 'Email or files not found in the event' });
            }
        }

        res.status(200).send('Webhook received and processed.');
    } catch (error) {
        addLog({ message: 'Error processing the webhook', error });
        res.status(500).send('Error processing the webhook.');
    }
});

async function getPublicUrl(assetId) {
    const query = JSON.stringify({
        query: `
            query {
                assets (ids: [${assetId}]) {
                    public_url
                }
            }
        `
    });

    const config = {
        method: 'post',
        url: API_URL,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        data: query
    };

    try {
        const response = await axios(config);
        if (response.data.data && response.data.data.assets.length > 0) {
            return response.data.data.assets[0].public_url;
        } else {
            throw new Error('Public URL not found for the provided assetId.');
        }
    } catch (error) {
        throw new Error(`Error in the GraphQL query: ${error.message}`);
    }
}

async function downloadFile(fileUrl, fileName) {
    const date = new Date();
    const timestamp = `${date.getDate().toString().padStart(2, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getFullYear()}-${date.getHours().toString().padStart(2, '0')}h-${date.getMinutes().toString().padStart(2, '0')}m-${date.getSeconds().toString().padStart(2, '0')}s`;
    const filePath = path.join(DOWNLOAD_DIR, `${fileName}-${timestamp}`);
    const writer = fs.createWriteStream(filePath);

    try {
        const response = await axios({
            url: fileUrl,
            method: 'GET',
            responseType: 'stream'
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                addLog({ message: 'File downloaded', filePath });
                resolve(filePath);
            });
            writer.on('error', reject);
        });
    } catch (error) {
        addLog({ message: 'Error downloading the file', error });
    }
}

async function processFileUpload(email, filePath) {
    const items = await findItemByEmail([1524952207], email);
    if (items.length > 0) {
        addLog({ message: 'Email exists in board', email, items });
        for (const item of items) {
            addLog({ message: 'Uploading file to item', itemId: item.id });
            await uploadAndAddFileToItem(item.id, filePath);
            addLog({ message: 'File uploaded to item', itemId: item.id });
        }
    } else {
        addLog({ message: 'Email not found in board', email });
    }
}

async function findItemByEmail(boardIds, email) {
    if (!email) {
        throw new Error("Email is undefined");
    }

    const items = await Promise.all(boardIds.map(async boardId => {
        let allItems = [];
        let cursor = null;
        let moreItems = true;

        while (moreItems) {
            const query = JSON.stringify({
                query: `
                    query {
                        items_page_by_column_values (limit: 500, board_id: ${boardId}, columns: [{column_id: "e_mail9__1", column_values: ["${email}"]}], cursor: ${cursor ? `"${cursor}"` : null}) {
                            cursor
                            items {
                                id
                                name
                                column_values(ids: ["e_mail9__1"]) {
                                    text
                                }
                            }
                        }
                    }
                `
            });

            const config = {
                method: 'post',
                url: API_URL,
                headers: {
                    'Authorization': `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json'
                },
                data: query
            };

            try {
                const response = await axios(config);
                addLog({ message: 'Response from item search', response: response.data });
                const data = response.data.data.items_page_by_column_values;
                allItems = allItems.concat(data.items);
                cursor = data.cursor;
                moreItems = cursor !== null;
            } catch (error) {
                addLog({ message: 'Error searching item by email', error });
                moreItems = false;
            }
        }

        return allItems.filter(item =>
            item.column_values.some(col => col.text === email)
        ).map(item => ({ boardId, id: item.id }));
    }));

    return items.flat();
}

async function uploadAndAddFileToItem(itemId, filePath) {
    const mutation = `
        mutation($file: File!) {
            add_file_to_column (item_id: ${itemId}, column_id: "archivo__1", file: $file) {
                id
            }
        }
    `;
    const formData = new FormData();
    formData.append('query', mutation);
    formData.append('variables[file]', fs.createReadStream(filePath));

    try {
        const response = await axios.post(FILE_UPLOAD_URL, formData, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                ...formData.getHeaders()
            }
        });

        addLog({ message: 'File added to column', response: response.data });
    } catch (error) {
        addLog({ message: 'Error in uploadAndAddFileToItem', error: error.response ? error.response.data : error.message });
    }
}

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
