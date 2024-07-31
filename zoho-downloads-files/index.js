import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import FormData from 'form-data';
import express from 'express';
import cron from 'node-cron';

dotenv.config();

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const refresh_token = process.env.REFRESH_TOKEN;
const api_domain = process.env.API_DOMAIN;
const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL;
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadedFilesPath = path.join(__dirname, 'uploaded-files.json');
let uploadedFiles = {};

if (fs.existsSync(uploadedFilesPath)) {
    try {
        const fileData = fs.readFileSync(uploadedFilesPath, 'utf8');
        uploadedFiles = JSON.parse(fileData || '{}');
    } catch (error) {
        console.error('Error reading or parsing uploaded-files.json:', error);
        uploadedFiles = {};
    }
}

function saveUploadedFiles() {
    fs.writeFileSync(uploadedFilesPath, JSON.stringify(uploadedFiles, null, 2));
}

async function getAccessToken() {
    try {
        const response = await axios.post('https://accounts.zoho.eu/oauth/v2/token', null, {
            params: {
                client_id: client_id,
                client_secret: client_secret,
                grant_type: 'refresh_token',
                refresh_token: refresh_token
            }
        });
        return response.data.access_token;
    } catch (error) {
        console.error('Error obtaining access token:', error.response ? error.response.data : error.message);
    }
}

async function downloadAttachment(moduleApiName, recordId, attachmentId, filePath, access_token) {
    try {
        const response = await axios.get(`${api_domain}/crm/v2/${moduleApiName}/${recordId}/Attachments/${attachmentId}`, {
            headers: {
                Authorization: `Zoho-oauthtoken ${access_token}`
            },
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('Error downloading attachment:', error.response ? error.response.data : error.message);
    }
}

async function getAttachments(recordId, email, access_token) {
    try {
        const response = await axios.get(`${api_domain}/crm/v2/PatientsNew/${recordId}/Attachments`, {
            headers: {
                Authorization: `Zoho-oauthtoken ${access_token}`
            }
        });
        const attachments = response.data.data;

        const dirPath = path.join(__dirname, 'patients-attachments', email);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        for (const attachment of attachments) {
            const filePath = path.join(dirPath, attachment.File_Name);
            await downloadAttachment('PatientsNew', recordId, attachment.id, filePath, access_token);
            console.log(`Attachment downloaded: ${filePath}`);
        }
        return attachments;
    } catch (error) {
        console.error('Error fetching attachments:', error.response ? error.response.data : error.message);
        return [];
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
                if (response.data.errors) {
                    console.log('Response from item search:', response.data.errors);
                    moreItems = false;
                    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds before retrying
                    continue;
                }
                const data = response.data.data.items_page_by_column_values;
                allItems = allItems.concat(data.items);
                cursor = data.cursor;
                moreItems = cursor !== null;
            } catch (error) {
                console.error('Error searching item by email:', error);
                moreItems = false;
            }
        }

        return allItems.filter(item =>
            item.column_values.some(col => col.text === email)
        ).map(item => ({ boardId, id: item.id }));
    }));

    return items.flat();
}

async function uploadAndAddFileToItem(itemId, filePath, columnId) {
    const mutation = `
        mutation($file: File!) {
            add_file_to_column (item_id: ${itemId}, column_id: "${columnId}", file: $file) {
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

        console.log('File added to column:', response.data);
    } catch (error) {
        console.error('Error in uploadAndAddFileToItem:', error.response ? error.response.data : error.message);
    }
}

async function processFileUpload(email, filePath) {
    const boardColumnMap = {
        1524952207: 'dup__of_upload_file__1',
        1556223297: 'archivo5__1'
    };

    const boardIds = Object.keys(boardColumnMap).map(Number);
    const items = await findItemByEmail(boardIds, email);

    if (items.length > 0) {
        console.log(`Email found in boards for ${email}:`, items);
        for (const item of items) {
            const columnId = boardColumnMap[item.boardId];
            if (columnId) {
                console.log(`Uploading file to item ${item.id} on board ${item.boardId}`);
                await uploadAndAddFileToItem(item.id, filePath, columnId);
                console.log(`File uploaded to item ${item.id} on board ${item.boardId}`);
            } else {
                console.log(`Column ID not found for board ${item.boardId}`);
            }
        }
    } else {
        console.log(`Email not found in any board for ${email}`);
    }
}

async function getPatients() {
    const access_token = await getAccessToken();

    if (!access_token) {
        console.error('No access token obtained');
        return;
    }

    let page = 1;
    let morePages = true;

    while (morePages) {
        try {
            const response = await axios.get(`${api_domain}/crm/v2/PatientsNew`, {
                headers: {
                    Authorization: `Zoho-oauthtoken ${access_token}`
                },
                params: {
                    page: page
                }
            });

            const patients = response.data.data;
            if (patients.length === 0) {
                morePages = false;
                break;
            }

            for (const patient of patients) {
                try {
                    console.log('Patient data:', patient);
                    const attachments = await getAttachments(patient.id, patient.Email, access_token);
                    console.table({
                        'Full Name': patient.Full_Name,
                        'Email': patient.Email,
                        'Phone': patient.Phone,
                        'Country': patient.Country,
                        'Lead Source': patient.Lead_Source,
                        'Lead Status': patient.Lead_Status,
                        'Attachments': attachments.map(att => att.File_Name).join(', ')
                    });

                    const dirPath = path.join(__dirname, 'patients-attachments', patient.Email);
                    fs.readdir(dirPath, async (err, files) => {
                        if (err) {
                            console.error('Error reading directory:', err);
                            return;
                        }

                        for (const file of files) {
                            const filePath = path.join(dirPath, file);
                            if (!uploadedFiles[patient.Email]) {
                                uploadedFiles[patient.Email] = [];
                            }
                            if (!uploadedFiles[patient.Email].includes(file)) {
                                await processFileUpload(patient.Email, filePath);
                                uploadedFiles[patient.Email].push(file);
                                saveUploadedFiles();
                            } else {
                                console.log(`File ${file} already uploaded for ${patient.Email}`);
                            }
                        }
                    });
                } catch (error) {
                    console.error(`Error processing patient ${patient.Email}:`, error);
                }
            }

            page++;
        } catch (error) {
            console.error('Error making API call:', error.response ? error.response.data : error.message);
            morePages = false;
        }
    }

    console.log("WORK FINISHED !!!");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Server is running');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Schedule the cron job to run at 6am and 2pm Paris time
cron.schedule('0 6,14 * * *', () => {
    console.log('Running the getPatients function at 6am and 2pm Paris time');
    getPatients();
}, {
    timezone: "Europe/Paris"
});

// Initial call to getPatients to start the process
getPatients();
