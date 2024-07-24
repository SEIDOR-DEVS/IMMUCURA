import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import FormData from 'form-data';

dotenv.config();

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const refresh_token = process.env.REFRESH_TOKEN;
const api_domain = process.env.API_DOMAIN;
const limit = 3; // Limitar a 3 pacientes
const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL;
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file';

// Obtener el nombre de archivo de este script para calcular __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Función para obtener el Access Token utilizando el Refresh Token
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

// Función para descargar un adjunto
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

// Función para obtener los adjuntos de un paciente
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

// Función para buscar un ítem por email en Monday.com
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
                console.log('Response from item search:', response.data);
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

// Función para subir archivos a un ítem en Monday.com
async function uploadAndAddFileToItem(itemId, filePath) {
    const mutation = `
        mutation($file: File!) {
            add_file_to_column (item_id: ${itemId}, column_id: "dup__of_upload_file__1", file: $file) {
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

// Función para procesar la subida de archivos
async function processFileUpload(email, filePath) {
    const items = await findItemByEmail([1524952207], email);
    if (items.length > 0) {
        console.log(`Email found in board for ${email}:`, items);
        for (const item of items) {
            console.log(`Uploading file to item ${item.id}`);
            await uploadAndAddFileToItem(item.id, filePath);
            console.log(`File uploaded to item ${item.id}`);
        }
    } else {
        console.log(`Email not found in board for ${email}`);
    }
}

// Función para obtener la información de los pacientes y subir los archivos a Monday.com
async function getPatients() {
    const access_token = await getAccessToken();

    if (!access_token) {
        console.error('No access token obtained');
        return;
    }

    try {
        const response = await axios.get(`${api_domain}/crm/v2/PatientsNew`, {
            headers: {
                Authorization: `Zoho-oauthtoken ${access_token}`
            },
            params: {
                per_page: limit // Limitar a 3 pacientes
            }
        });

        // Formatear y mostrar los datos en una tabla
        const patients = response.data.data;
        for (const patient of patients) {
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

            // Procesar la subida de archivos a Monday.com
            const dirPath = path.join(__dirname, 'patients-attachments', patient.Email);
            fs.readdir(dirPath, async (err, files) => {
                if (err) {
                    console.error('Error reading directory:', err);
                    return;
                }

                for (const file of files) {
                    const filePath = path.join(dirPath, file);
                    await processFileUpload(patient.Email, filePath);
                }
            });
        }
    } catch (error) {
        console.error('Error making API call:', error.response ? error.response.data : error.message);
    }
}

// Llamada a la función getPatients para iniciar el proceso
getPatients();

/*async function makeAPILeads() {
    const access_token = await getAccessToken();

    if (!access_token) {
        console.error('No access token obtained');
        return;
    }

    try {
        const response = await axios.get(`${api_domain}/crm/v2/Leads`, {
            headers: {
                Authorization: `Zoho-oauthtoken ${access_token}`
            }
        });

        // Formatear y mostrar los datos en una tabla
        const leads = response.data.data;
        leads.forEach(lead => {
            console.table({
                'Full Name': lead.Full_Name,
                'Email': lead.Email,
                'Phone': lead.Phone,
                'Country': lead.Country,
                'Lead Source': lead.Lead_Source,
                'Lead Status': lead.Lead_Status,
                'Notes': lead.Notes
            });
        });
    } catch (error) {
        console.error('Error making API call:', error.response ? error.response.data : error.message);
    }
}
// CALL FUNCTION makeAPILeads
makeAPILeads();
*/

// Función para obtener la lista de módulos y verificar el nombre del módulo de pacientes
/*async function getModules() {
    const access_token = await getAccessToken();

    if (!access_token) {
        console.error('No access token obtained');
        return;
    }

    try {
        const response = await axios.get(`${api_domain}/crm/v2/settings/modules`, {
            headers: {
                Authorization: `Zoho-oauthtoken ${access_token}`
            }
        });

        // Imprime la lista de módulos para verificar el nombre del módulo de pacientes
        console.table(response.data.modules.map(module => ({
            'Module Name': module.module_name,
            'API Name': module.api_name
        })));

        // Encontrar el API name del módulo "Patients"
        const patientsModule = response.data.modules.find(module => module.module_name === 'Patients');
        if (patientsModule) {
            console.log(`API Name for Patients module: ${patientsModule.api_name}`);
            // Llamar a la función para obtener la información de los pacientes
            await getPatients(access_token, patientsModule.api_name);
        } else {
            console.error('Patients module not found');
        }

    } catch (error) {
        console.error('Error fetching modules:', error.response ? error.response.data : error.message);
    }
}

getModules();
 */
