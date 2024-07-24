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

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const API_URL = 'https://api.monday.com/v2';
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file';

// Definir __dirname en el contexto de un módulo ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOAD_DIR = path.join(__dirname, 'files-uploaded');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR);
}

app.post('/', async (req, res) => {
    const event = req.body.event;
    console.log(`Webhook recibido: ${JSON.stringify(req.body, null, 2)}`);

    try {
        const email = event.columnValues?.e_mail__1?.email || event.columnValues?.e_mail__1?.text;
        console.log(`Email obtenido del evento: ${email}`);

        if (event.type === 'update_column_value' && event.columnId === 'upload_file__1') {
            const files = event.value?.files;
            if (files && files.length > 0) {
                for (const file of files) {
                    const assetId = file.assetId;
                    const fileName = file.name;
                    try {
                        const fileUrl = await getPublicUrl(assetId);
                        console.log(`URL pública del archivo: ${fileUrl}`);
                        const uniqueFileName = `${Date.now()}-${fileName}`;
                        const filePath = await downloadFile(fileUrl, uniqueFileName);

                        if (email) {
                            const items = await findItemByEmail([1524952207], email);
                            if (items.length > 0) {
                                console.log(`El correo electrónico ${email} existe en el tablero 1524952207. Items: ${JSON.stringify(items)}`);
                                for (const item of items) {
                                    console.log(`Subiendo archivo al item ${item.id}`);
                                    await uploadFileToItem(item.id, filePath);
                                    console.log(`Archivo subido al item ${item.id}`);
                                }
                            } else {
                                console.log(`El correo electrónico ${email} no se encontró en el tablero 1524952207`);
                            }
                        } else {
                            console.log('Correo electrónico no encontrado en el evento.');
                        }
                    } catch (error) {
                        console.error('Error obteniendo la URL pública o descargando el archivo:', error);
                    }
                }
            } else {
                console.log('Archivos no encontrados en el evento.');
            }
        } else if (event.type === 'create_pulse') {
            if (email) {
                try {
                    const items = await findItemByEmail([1524952207], email);
                    if (items.length > 0) {
                        console.log(`El correo electrónico ${email} existe en el tablero 1524952207. Items: ${JSON.stringify(items)}`);
                    } else {
                        console.log(`El correo electrónico ${email} no se encontró en el tablero 1524952207`);
                    }
                } catch (error) {
                    console.error('Error al buscar el correo electrónico en el tablero:', error);
                }
            } else {
                console.log('Correo electrónico no encontrado en el evento.');
            }
        }

        res.status(200).send('Webhook recibido y procesado.');
    } catch (error) {
        console.error('Error en el procesamiento del webhook:', error);
        res.status(500).send('Error en el procesamiento del webhook.');
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
            throw new Error('No se encontró la URL pública para el assetId proporcionado.');
        }
    } catch (error) {
        throw new Error(`Error en la consulta GraphQL: ${error.message}`);
    }
}

async function downloadFile(fileUrl, fileName) {
    const filePath = path.join(DOWNLOAD_DIR, fileName);
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
                console.log(`Archivo descargado: ${filePath}`);
                resolve(filePath);
            });
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('Error descargando el archivo:', error);
    }
}

async function findItemByEmail(boardIds, email) {
    if (!email) {
        throw new Error("email is undefined");
    }

    const items = await Promise.all(boardIds.map(async boardId => {
        const query = JSON.stringify({
            query: `
                query {
                    boards(ids: ${boardId}) {
                        items_page(limit: 4) {
                            items {
                                id
                                name
                                column_values {
                                    id
                                    text
                                }
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
            console.log("Respuesta de la búsqueda de elementos:", JSON.stringify(response.data, null, 2));
            if (response.data.data && response.data.data.boards[0].items_page.items.length > 0) {
                const items = response.data.data.boards[0].items_page.items;
                return items.filter(item =>
                    item.column_values.some(col => (col.id === "e_mail9__1" || col.id === "e_mail3__1") && col.text === email)
                ).map(item => ({ boardId, id: item.id }));
            } else {
                console.log(`No se encontraron elementos en el tablero ${boardId}`);
            }
        } catch (error) {
            console.error("Error al buscar el elemento por correo electrónico:", error);
        }
        return [];
    }));

    return items.flat();
}

async function uploadFileToItem(itemId, filePath) {
    console.log(`Preparando para subir el archivo ${filePath} al item ${itemId}`);
    const formData = new FormData();
    formData.append('query', `mutation add_file($file: File!) { add_file_to_column (item_id: ${itemId}, column_id: "archivo__1", file: $file) { id } }`);
    formData.append('map', '{"image":"variables.file"}');
    formData.append('image', fs.createReadStream(filePath));

    const config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: FILE_UPLOAD_URL,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'API-version': '2023-10',
            ...formData.getHeaders()
        },
        data: formData
    };

    try {
        const response = await axios(config);
        console.log('Archivo subido:', JSON.stringify(response.data));
    } catch (error) {
        console.error('Error subiendo el archivo:', error.response ? error.response.data : error.message);
        console.log('Config:', JSON.stringify(config, null, 2));
        console.log('FormData:', formData);
    }
}

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
