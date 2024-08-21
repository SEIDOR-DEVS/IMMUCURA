import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Define __dirname para ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const API_DOMAIN = process.env.API_DOMAIN || 'https://www.zohoapis.eu';
const API_URL = process.env.API_URL;
const API_KEY = process.env.API_KEY;

// Mapea las columnas de Monday.com
const emailColumnMap = {
    1499741852: 'lead_email', // Board 1499741852, columna de email
    1565676276: 'lead_email', // Board 1565676276, columna de email
};

const ownerColumnMap = {
    1499741852: 'personas7__1', // Reemplaza con el ID de la columna "people" en el Board 1499741852
    1565676276: 'personas__1', // Reemplaza con el ID de la columna "people" en el Board 1565676276
};

const textColumnMap = {
    1499741852: 'texto__1', // Board 1499741852, columna de texto
    1565676276: 'texto__1', // Board 1565676276, columna de texto
};

const notesColumnMap = {
    1499741852: 'texto_largo__1', // Board 1499741852, columna de Notes
    1565676276: 'texto_largo__1', // Board 1565676276, columna de Notes
};

const tokenFilePath = path.join(__dirname, 'access-token.json');

// Function to save the access token to a file
function saveAccessToken(token) {
    fs.writeFileSync(tokenFilePath, JSON.stringify({ accessToken: token, timestamp: Date.now() }));
}

// Function to load the access token from a file
function loadAccessToken() {
    if (fs.existsSync(tokenFilePath)) {
        const data = fs.readFileSync(tokenFilePath, 'utf8');
        return JSON.parse(data);
    }
    return null;
}

let accessToken = null;
let tokenExpirationTime = 0;

async function getAccessToken(forceRenew = false) {
    const savedTokenData = loadAccessToken();

    if (forceRenew || !savedTokenData || Date.now() >= tokenExpirationTime) {
        try {
            const response = await axios.post(`https://accounts.zoho.eu/oauth/v2/token`, null, {
                params: {
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: REFRESH_TOKEN
                }
            });
            if (response.data && response.data.access_token) {
                console.log('Access token obtained successfully.');
                saveAccessToken(response.data.access_token);
                accessToken = response.data.access_token;
                tokenExpirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
                return response.data.access_token;
            } else {
                console.error('Unexpected response:', response.data);
                return null;
            }
        } catch (error) {
            console.error('Error obtaining access token:', error.response ? error.response.data : error.message);
            return null;
        }
    }

    console.log('Using saved access token.');
    accessToken = savedTokenData.accessToken;
    tokenExpirationTime = savedTokenData.timestamp + 3600000 - 60000;
    return savedTokenData.accessToken;
}

// Función para obtener todos los leads
async function getAllLeads(accessToken) {
    let allLeads = [];
    let pageToken = null;  // Inicializa el pageToken como null
    let morePages = true;
    const fields = 'Full_Name,id,Owner,Email,Phone,Mobile,Lead_Status,Notes'; // Incluyendo Notes

    console.log('Fetching all leads from Zoho CRM...');

    while (morePages) {
        if (Date.now() >= tokenExpirationTime) { // Renueva si el token ha expirado
            console.log('Token expired, renewing...');
            accessToken = await getAccessToken(true);
        }

        try {
            // Configura los parámetros de la solicitud, incluyendo el page_token si existe
            const params = {
                fields: fields,
                per_page: 200  // Máximo permitido por solicitud
            };
            if (pageToken) {
                params.page_token = pageToken;  // Añade el page_token si existe
            }

            const response = await axios.get(`${API_DOMAIN}/crm/v3/Leads`, {
                headers: {
                    Authorization: `Zoho-oauthtoken ${accessToken}`
                },
                params: params
            });

            const leads = response.data.data || [];
            const nextPageToken = response.data.info ? response.data.info.next_page_token : null;

            if (leads.length > 0) {
                allLeads.push(...leads);
                console.log(`Fetched ${leads.length} leads, total fetched: ${allLeads.length}`);
                pageToken = nextPageToken; // Asigna el siguiente page_token para la próxima solicitud
                morePages = pageToken !== null;
            } else {
                morePages = false;
                console.log('No more leads to fetch.');
            }
        } catch (error) {
            if (error.response && error.response.data && error.response.data.code === 'INVALID_TOKEN') {
                console.log('Invalid token detected, renewing access token...');
                accessToken = await getAccessToken(true);
                continue; // Reintentar la solicitud con el nuevo token
            } else if (error.response && error.response.data.code === 'DISCRETE_PAGINATION_LIMIT_EXCEEDED') {
                console.error('Pagination limit exceeded:', error.response.data.message);
                morePages = false;
            } else {
                console.error('Error fetching leads:', error.response ? error.response.data : error.message);
                morePages = false;
            }
        }
    }

    console.log(`Total unique leads fetched: ${allLeads.length}`);
    return allLeads;
}

// Función para buscar personas por nombre en Monday.com
async function findPersonByName(name) {
    const query = `
        query {
            users {
                id
                name
            }
        }
    `;

    const config = {
        method: 'post',
        url: API_URL,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        data: JSON.stringify({ query })
    };

    try {
        const response = await axios(config);
        const users = response.data.data.users;
        const user = users.find(user => user.name.toLowerCase() === name.toLowerCase());
        if (user) {
            return user.id;
        } else {
            console.log(`User with name ${name} not found.`);
            return null;
        }
    } catch (error) {
        console.error('Error finding person by name:', error.response ? error.response.data : error.message);
        return null;
    }
}

// Función para buscar items por email en Monday.com
async function findItemByEmail(boardIds, email) {
    if (!email) {
        throw new Error("Email is undefined");
    }

    const items = await Promise.all(boardIds.map(async boardId => {
        let allItems = [];
        let cursor = null;
        let moreItems = true;
        const emailColumnId = emailColumnMap[boardId];

        while (moreItems) {
            const query = JSON.stringify({
                query: `
                    query {
                        items_page_by_column_values (board_id: ${boardId}, columns: [{column_id: "${emailColumnId}", column_values: ["${email}"]}], cursor: ${cursor ? `"${cursor}"` : null}) {
                            cursor
                            items {
                                id
                                name
                                column_values(ids: ["${emailColumnId}"]) {
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
                    console.error('GraphQL Response Errors:', response.data.errors);
                    moreItems = false;
                    await new Promise(resolve => setTimeout(resolve, 10000));
                    continue;
                }
                const data = response.data.data.items_page_by_column_values;
                allItems = allItems.concat(data.items);
                cursor = data.cursor;
                moreItems = cursor !== null;
            } catch (error) {
                console.error('Error searching item by email:', error.response ? error.response.data : error.message);
                moreItems = false;
            }
        }

        const filteredItems = allItems.filter(item =>
            item.column_values.some(col => col.text === email)
        ).map(item => ({ boardId, id: item.id }));

        if (filteredItems.length > 0) {
            console.log(`Found items for email ${email} in board ${boardId}:`, filteredItems);
        } else {
            console.log(`No items found for email ${email} in board ${boardId}.`);
        }

        return filteredItems;
    }));

    return items.flat();
}

async function updateMondayColumns(itemId, boardId, ownerName, notes) {
    // Buscar el ID de la persona en Monday.com por nombre
    const ownerId = await findPersonByName(ownerName);

    // Asegúrate de que las comillas dobles y otros caracteres especiales estén correctamente escapados
    const escapedNotes = notes ? notes.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n\\n') : '';
    const escapedOwnerName = ownerName ? ownerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';

    // Crear el JSON para las columnas
    let columnValues = {
        [textColumnMap[boardId]]: escapedOwnerName,
        [notesColumnMap[boardId]]: { text: escapedNotes }
    };

    if (ownerId) {
        columnValues[ownerColumnMap[boardId]] = { personsAndTeams: [{ id: ownerId, kind: "person" }] };
    }

    const mutation = `
        mutation {
            change_multiple_column_values(item_id: ${itemId}, board_id: ${boardId}, column_values: "${JSON.stringify(columnValues).replace(/"/g, '\\"')}")
            { id }
        }
    `;

    const config = {
        method: 'post',
        url: API_URL,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        data: JSON.stringify({ query: mutation })
    };

    try {
        const response = await axios(config);
        if (response.data.errors) {
            console.error('Error updating Monday columns:', response.data.errors);

            // Manejar el error específico de asignación de persona
            if (response.data.errors.some(e => e.message.includes('ColumnValueException'))) {
                console.log(`Error assigning person with ID ${ownerId} on board ${boardId}. Skipping person assignment.`);
                // Volver a intentar la mutación sin la columna "people"
                delete columnValues[ownerColumnMap[boardId]];
                const retryMutation = `
                    mutation {
                        change_multiple_column_values(item_id: ${itemId}, board_id: ${boardId}, column_values: "${JSON.stringify(columnValues).replace(/"/g, '\\"')}")
                        { id }
                    }
                `;
                const retryConfig = {
                    method: 'post',
                    url: API_URL,
                    headers: {
                        'Authorization': `Bearer ${API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify({ query: retryMutation })
                };
                try {
                    const retryResponse = await axios(retryConfig);
                    if (retryResponse.data.errors) {
                        console.error('Retry error updating Monday columns:', retryResponse.data.errors);
                    } else {
                        console.log('Successfully updated Monday columns without person assignment:', retryResponse.data);
                    }
                } catch (retryError) {
                    console.error('Error retrying Monday columns update:', retryError.response ? retryError.response.data : retryError.message);
                }
            }
        } else {
            console.log('Successfully updated Monday columns:', response.data);
        }
    } catch (error) {
        console.error('Error updating Monday columns:', error.response ? error.response.data : error.message);
    }
}

// Función principal para procesar leads y actualizar Monday.com
async function main() {
    let accessToken = await getAccessToken();
    if (!accessToken) {
        console.log('Failed to obtain an access token.');
        return; // Evitar que el script se detenga abruptamente
    }

    const leads = await getAllLeads(accessToken);
    console.log(`Processing ${leads.length} leads...`);

    if (!leads.length) {
        console.log("No leads were fetched, exiting.");
        return;
    }

    const boardIds = Object.keys(emailColumnMap).map(Number); // Obteniendo los IDs de los tableros

    let leadCounter = 0;

    for (const lead of leads) {
        leadCounter++;
        const leadEmail = lead.Email;

        console.log(`\n\n\nProcessing Lead ${leadCounter}: ${lead.Full_Name}`);

        if (!leadEmail) {
            console.log(`Lead ${lead.Full_Name} has no email, skipping.`);
            continue;
        }

        const items = await findItemByEmail(boardIds, leadEmail);

        if (items.length > 0) {
            for (const item of items) {
                console.log(`Found and updating item ${item.id} on board ${item.boardId} for lead ${lead.Full_Name}`);
                await updateMondayColumns(item.id, item.boardId, lead.Owner.name, lead.Notes || '');
            }
        } else {
            console.log(`No matching items found for email ${leadEmail}`);
        }
    }

    console.log('***************************** WORK DONE ! *****************************');
    console.log('***************************** WORK DONE ! *****************************');
    console.log('***************************** WORK DONE ! *****************************');
    console.log('***************************** WORK DONE ! *****************************');
    console.log('***************************** WORK DONE ! *****************************');
    console.log('***************************** WORK DONE ! *****************************');
    console.log('***************************** WORK DONE ! *****************************');
}

main();
