import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import FormData from 'form-data';
import express from 'express';

dotenv.config();

const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL;
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001; // Cambiar a 3001 para el nuevo proxy

app.use(express.json());

// Asegurarse de que el directorio para archivos subidos existe
const DOWNLOAD_DIR = path.join(__dirname, 'files-uploaded');
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Endpoint para recibir el webhook de Monday.com
app.post('/immucura-webhooks', async (req, res) => {
    // Responder al desafío del webhook de Monday.com
    if (req.body.challenge) {
        console.log('Responding to challenge');
        return res.status(200).json({ challenge: req.body.challenge });
    }

    const event = req.body.event;
    console.log(`Webhook received: ${JSON.stringify(req.body, null, 2)}`);

    try {
        if (event && event.type === 'create_pulse') {
            const email = event.columnValues?.e_mail__1?.email;
            const files = event.columnValues?.upload_file__1?.files;

            if (email && files && files.length > 0) {
                console.log(`Email obtained from create_pulse event: ${email}`);
                for (const file of files) {
                    const assetId = file.assetId;
                    const fileName = file.name;
                    try {
                        const fileUrl = await getPublicUrl(assetId);
                        console.log(`Public URL of the file: ${fileUrl}`);
                        const filePath = await downloadFile(fileUrl, fileName, email);
                        await processFileUpload(email, filePath);
                    } catch (error) {
                        console.error('Error getting public URL or downloading the file:', error);
                    }
                }
            } else {
                console.log('Email or files not found in the event.');
            }
        }
        res.status(200).send('Webhook received and processed.');
    } catch (error) {
        console.error('Error processing the webhook:', error);
        res.status(500).send('Error processing the webhook.');
    }
});

// Funciones auxiliares

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

async function downloadFile(fileUrl, fileName, email) {
    const dirPath = path.join(DOWNLOAD_DIR, email);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    const filePath = path.join(dirPath, fileName);
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
                console.log(`File downloaded: ${filePath}`);
                resolve(filePath);
            });
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('Error downloading the file:', error);
    }
}

async function processFileUpload(email, filePath) {
    const boardIds = [1556223297, 1524952207];
    const items = await findItemByEmail(boardIds, email);
    if (items.length > 0) {
        console.log(`Email ${email} exists in boards. Items: ${JSON.stringify(items)}`);
        for (const item of items) {
            console.log(`Uploading file to item ${item.id} in board ${item.boardId}`);
            await uploadAndAddFileToItem(item.id, filePath);
            console.log(`File uploaded to item ${item.id}`);
        }
    } else {
        console.log(`Email ${email} not found in boards`);
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
                        items_page_by_column_values (board_id: ${boardId}, columns: [{column_id: "e_mail9__1", column_values: ["${email}"]}], cursor: ${cursor ? `"${cursor}"` : null}) {
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
                console.log("Response from item search:", JSON.stringify(response.data, null, 2));
                const data = response.data.data.items_page_by_column_values;
                allItems = allItems.concat(data.items);
                cursor = data.cursor;
                moreItems = cursor !== null;
                console.log(`Retrieved ${data.items.length} items, total: ${allItems.length}`);
            } catch (error) {
                console.error("Error searching item by email:", error);
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
        console.log('File added:', response.data);
    } catch (error) {
        console.error('Error in uploadAndAddFileToItem:', error.response ? error.response.data : error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

