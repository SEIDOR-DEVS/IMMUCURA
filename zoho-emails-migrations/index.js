import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { htmlToText } from 'html-to-text';
import PDFDocument from 'pdfkit';
import moment from 'moment';
import FormData from 'form-data';

dotenv.config();

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const API_DOMAIN = process.env.API_DOMAIN || 'https://www.zohoapis.eu';
const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL;
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file';

const CONFIDENTIALITY_NOTICE = [
    /CONFIDENTIALITY NOTICE:([\s\S]*?)(?=IMMUCURA LIMITED|$)/g,
    /AVIS DE CONFIDENTIALITÉ :([\s\S]*?)(?=IMMUCURA LIMITED|$)/g,
    /IMMUCURA LIMITED([\s\S]*?)(?=(\n\n|\s*$))/g,
    /\[crm\\img_id:[^\]]*\]/g,
    /AVISO LEGAL:([\s\S]*?)(?=PROTECCIÓN DE DATOS|$)/g,
    /confidencial sometida a secreto profesional([\s\S]*?)(?=expresa de Immucura Med S.L.|$)/gi,
    /expresa de Immucura Med S.L.([\s\S]*?)(?=PROTECCIÓN DE DATOS|$)/gi,
    /LEGAL WARNING:([\s\S]*?)(?=This message and its attachments|$)/g,
    /PROTECCIÓN DE DATOS([\s\S]*?)(?=(\n\n|\s*$))/gi,
    /Br3athe hereby informs you that([\s\S]*?)(?=Confidentiality:|$)/gi,
    /Confidentiality:([\s\S]*?)(?=(\n\n|\s*$))/gi,
    /In compliance with the European Union General Data Protection Regulation \(GDPR\), you receive this message([\s\S]*?)(?=Headquarter:|$)/gi,
    /Headquarter:([\s\S]*?)(?=(\n\n|\s*$))/gi,
    /This message and its attachments are addressed exclusively([\s\S]*?)(?=(\n\n|\s*$))/gi,
    /Before printing this message([\s\S]*?)(?=(\n\n|\s*$))/gi,
    /Website: ([\s\S]*?)(?=(\n\n|\s*$))/gi,
    /Email: ([\s\S]*?)(?=(\n\n|\s*$))/gi,
];

// Mapeo de columnas para Monday.com
const boardColumnMap = {
    1565676276: 'archivo7__1',
    1499741852: 'archivo1__1'
};

// Mapeo de columnas de correo electrónico en Monday.com
const emailColumnMap = {
    1565676276: 'lead_email',
    1499741852: 'lead_email'
};

// Ruta y carga de archivos subidos previamente
const uploadedFilesPath = path.join(__dirname, 'uploaded-files.json');
let uploadedFiles = {};

// Cargar los archivos ya subidos desde uploaded-files.json
if (fs.existsSync(uploadedFilesPath)) {
    try {
        const fileData = fs.readFileSync(uploadedFilesPath, 'utf8');
        uploadedFiles = JSON.parse(fileData || '{}');
    } catch (error) {
        console.error('Error al leer o analizar uploaded-files.json:', error);
        uploadedFiles = {};
    }
}

// Función para guardar los archivos subidos en uploaded-files.json
function saveUploadedFiles() {
    fs.writeFileSync(uploadedFilesPath, JSON.stringify(uploadedFiles, null, 2));
}

const tokenFilePath = path.join(__dirname, 'access-token.json');

// Función para guardar el token en un archivo
function saveAccessToken(token) {
    fs.writeFileSync(tokenFilePath, JSON.stringify({ accessToken: token, timestamp: Date.now() }));
}

// Función para cargar el token de acceso desde el archivo
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

// El resto de tu código sigue igual, no olvides ahora que tienes las variables globales definidas, puedes utilizarlas en getAllLeads


// Modificación en la función getAllLeads para manejar errores de token inválido
async function getAllLeads(accessToken) {
    let allLeads = [];
    let progress = loadProgress();  // Cargar progreso si existe
    let pageToken = null;
    let morePages = true;
    let startFromNextLead = progress ? false : true;
    const maxLeads = 60000; // Establecer el objetivo de leads que deseas recuperar
    let leadsFetched = 0;

    console.log('Fetching all leads from Zoho CRM...');

    const seenLeads = new Set(); // Para seguimiento de leads ya procesados

    while (morePages && allLeads.length < maxLeads) {
        if (Date.now() >= tokenExpirationTime) { // Renueva si el token ha expirado
            console.log('Token expired, renewing...');
            accessToken = await getAccessToken(true);
        }

        try {
            const response = await axios.get(`${API_DOMAIN}/crm/v3/Leads`, {
                headers: {
                    Authorization: `Zoho-oauthtoken ${accessToken}`
                },
                params: {
                    fields: 'id,Full_Name,Email',
                    page_token: pageToken,
                    per_page: 200 // Máximo permitido por solicitud
                }
            });

            const leads = response.data.data || [];
            const nextPageToken = response.data.info ? response.data.info.next_page_token : null;

            if (leads.length > 0) {
                if (progress && !startFromNextLead) {
                    const lastProcessedIndex = leads.findIndex(lead => lead.Email === progress.lastLeadEmail && lead.id === progress.lastLeadId);
                    if (lastProcessedIndex !== -1) {
                        leads.splice(0, lastProcessedIndex + 1); // Eliminar los leads ya procesados
                        startFromNextLead = true;
                    }
                }

                for (let lead of leads) {
                    if (!seenLeads.has(lead.id)) {
                        seenLeads.add(lead.id);
                        allLeads.push(lead);
                        leadsFetched += 1;

                        if (leadsFetched % 1000 === 0) {
                            saveProgress(lead.Email, lead.id);
                        }
                    }
                }

                console.log(`Fetched ${leads.length} leads, total fetched: ${allLeads.length}`);
                pageToken = nextPageToken;
                morePages = pageToken !== null;

                if (allLeads.length >= maxLeads) {
                    morePages = false;
                    console.log(`Reached target of ${maxLeads} leads. Stopping fetch.`);
                }
            } else {
                morePages = false;
                console.log('No more leads to fetch.');
            }
        } catch (error) {
            if (error.response && error.response.data && error.response.data.code === 'INVALID_TOKEN') {
                console.log('Invalid token detected, renewing access token...');
                accessToken = await getAccessToken(true);
                continue; // Reintentar la solicitud con el nuevo token
            } else {
                console.error('Error fetching leads:', error.response ? error.response.data : error.message);
                morePages = false;
            }
        }
    }

    console.log(`Total unique leads fetched: ${allLeads.length}`);
    return allLeads;
}






// Función para obtener correos electrónicos de un lead específico desde Zoho
async function getEmailsOfLead(moduleApiName, leadId, accessToken) {
    try {
        console.log(`Fetching emails for lead ID: ${leadId}`);
        const url = `${API_DOMAIN}/crm/v3/${moduleApiName}/${leadId}/Emails`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`
            }
        });

        if (response.data && response.data.Emails) {
            console.log(`Found ${response.data.Emails.length} emails for lead ID: ${leadId}`);
            return response.data.Emails.map(email => ({
                subject: email.subject,
                from: `${email.from.email}`,
                to: email.to.map(to => to.email).join(', '),
                messageId: email.message_id,
                sentTime: email.time || 'No date available'
            }));
        } else {
            console.log('No emails found or no data available:', response.data);
            return [];
        }
    } catch (error) {
        console.error('Error fetching emails for lead:', error.response ? error.response.data : error.message);
        return [];
    }
}

// Función para guardar el progreso
function saveProgress(lastLeadEmail, lastLeadId) {
    const progress = {
        lastLeadEmail: lastLeadEmail,
        lastLeadId: lastLeadId
    };
    fs.writeFileSync('progress.json', JSON.stringify(progress, null, 2));
}

// Función para cargar el progreso
function loadProgress() {
    if (fs.existsSync('progress.json')) {
        const data = fs.readFileSync('progress.json', 'utf8');
        if (data.trim()) {  // Verifica que el archivo no esté vacío
            return JSON.parse(data);
        } else {
            console.log('progress.json está vacío. No se puede cargar el progreso.');
        }
    }
    return null;
}

// Función para obtener el contenido de un correo específico desde Zoho
async function getEmailContent(moduleApiName, leadId, messageId, accessToken) {
    try {
        const url = `${API_DOMAIN}/crm/v3/${moduleApiName}/${leadId}/Emails/${messageId}`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
            },
        });

        if (
            response.data &&
            response.data.email_related_list &&
            response.data.email_related_list.length > 0
        ) {
            const emailContent = response.data.email_related_list[0].content || 'No content available';
            return emailContent;
        }
        console.log('No email content found or no data available:', response.data);
        return 'No content available';
    } catch (error) {
        console.error('Error fetching email content:', error.response ? error.response.data : error.message);
        return 'No content available';
    }
}

function cleanEmailContent(content) {
    let cleanedContent = htmlToText(content, {
        wordwrap: 130,
        preserveNewlines: true
    });

    CONFIDENTIALITY_NOTICE.forEach(regex => {
        cleanedContent = cleanedContent.replace(regex, '');
    });

    // Eliminar enlaces de Twitter
    cleanedContent = cleanedContent.replace(/https?:\/\/(www\.)?twitter\.com\/[^\s]+/gi, '');

    // Unir líneas relacionadas en la firma (como Immucura Limited y dirección)
    cleanedContent = cleanedContent.replace(/(\n\s*)(Limited|Street,|Dublin|Mob:)/g, ' $2');

    // Corregir y mantener Mob y Email en la misma línea
    cleanedContent = cleanedContent.replace(/(Mob|Mobile|Phone|T):\s*(.*?)(\n|$)/gi, 'Mob: $2\n');
    cleanedContent = cleanedContent.replace(/Email:\s*(.*?)(\n|$)/gi, 'Email: $1\n');

    // Eliminar URLs no deseadas
    cleanedContent = cleanedContent.replace(/www\..*?(\n|$)/gi, '');

    // Agregar un salto de línea antes de la firma si no lo hay
    cleanedContent = cleanedContent.replace(/(Content:\n[^\n]+)(\n\n)?(\n(Mob|Mobile|Phone|Email))/g, '$1\n\n$3');

    // Eliminar saltos de línea múltiples en todo el contenido
    cleanedContent = cleanedContent.replace(/(\n\s*){2,}/g, '\n');

    return cleanedContent.trim();
}

function sanitizeFileName(fileName) {
    return fileName
        .replace(/[^a-z0-9]/gi, '_')  // Reemplaza caracteres no alfanuméricos por guiones bajos
        .replace(/_+/g, '_')           // Reemplaza múltiples guiones bajos por uno solo
        .replace(/^_+|_+$/g, '');      // Elimina los guiones bajos al inicio o al final del nombre
}

// Función para crear archivos PDF a partir de correos electrónicos
function createPDF(leadName, emailContents, leadEmail) {
    const sanitizedLeadName = sanitizeFileName(leadName || 'Unknown');
    const doc = new PDFDocument();
    const baseDir = path.join(__dirname, 'emails-downloads');
    const leadDir = path.join(baseDir, leadEmail);
    const outputFilePath = path.join(leadDir, `emails-${sanitizedLeadName}.pdf`);

    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir);
    }
    if (!fs.existsSync(leadDir)) {
        fs.mkdirSync(leadDir);
    }

    doc.pipe(fs.createWriteStream(outputFilePath));

    emailContents.forEach((content, index) => {
        if (index > 0) {
            doc.text('\n\n\n'); // Deja tres espacios antes del siguiente correo
        }
        const sentTimeFormatted = moment(content.sentTime).format('MMMM Do YYYY, h:mm:ss a');

        doc
            .fontSize(12)
            .text(
                `MAIL ${index + 1}:\nSent: ${sentTimeFormatted}\nSubject: ${content.subject}\nFrom: ${content.from}\nTo: ${content.to}\n\nContent:\n${content.content}\n\n\n\n`,
                {
                    align: 'left',
                    lineGap: 2,
                }
            );
    });

    doc.end();
    console.log(`PDF created for lead: ${sanitizedLeadName}`);
}

// Función para encontrar un item por correo electrónico en Monday.com
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

// Función para subir y añadir un archivo a un item en Monday.com
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

// Función para procesar la carga del archivo en Monday.com
async function processFileUpload(email, filePath) {
    const boardIds = Object.keys(boardColumnMap).map(Number);
    const items = await findItemByEmail(boardIds, email);

    if (items.length > 0) {
        console.log(`Email found in boards for ${email}:`, items);
        for (const item of items) {
            const columnId = boardColumnMap[item.boardId];
            if (columnId) {
                const fileName = path.basename(filePath);
                if (!uploadedFiles[item.boardId]) {
                    uploadedFiles[item.boardId] = {};
                }
                if (!uploadedFiles[item.boardId][email]) {
                    uploadedFiles[item.boardId][email] = [];
                }
                if (uploadedFiles[item.boardId][email].includes(fileName)) {
                    console.log(`File ${fileName} already uploaded for ${email} on board ${item.boardId}`);
                } else {
                    console.log(`Uploading file to item ${item.id} on board ${item.boardId}`);
                    await uploadAndAddFileToItem(item.id, filePath, columnId);
                    uploadedFiles[item.boardId][email].push(fileName);
                    saveUploadedFiles();
                    console.log(`File uploaded to item ${item.id} on board ${item.boardId}`);
                }
            } else {
                console.log(`Column ID not found for board ${item.boardId}`);
            }
        }
    } else {
        console.log(`Email not found in any board for ${email}`);
    }
}

// Función principal
// Función principal
// Función principal
async function main() {
    let accessToken = await getAccessToken();
    if (!accessToken) {
        console.log('Failed to obtain an access token.');
        return; // Evitar que el script se detenga abruptamente
    }

    // Cargar el progreso si existe
    let progress = loadProgress();
    let startProcessing = !progress; // Si no hay progreso, empieza desde el principio

    const leads = await getAllLeads(accessToken);
    console.log(`Processing ${leads.length} leads...`);

    if (!leads.length) {
        console.log("No leads were fetched, exiting.");
        return;
    }

    console.log("Starting lead processing...");
    console.log(`Starting lead processing from ${progress ? `lead ${progress.lastLeadId}` : 'the beginning'}`);


    for (const [index, lead] of leads.entries()) {
        const fullName = lead.Full_Name || 'Unknown Name';
        const leadEmail = lead.Email || 'no-email';

        // Saltar leads hasta llegar al último procesado
        if (progress && !startProcessing) {
            if (leadEmail === progress.lastLeadEmail && lead.id === progress.lastLeadId) {
                startProcessing = true;  // Comienza a procesar a partir de este lead
            } else {
                continue;  // Saltar los leads ya procesados
            }
        }

        try {
            console.log(`\nProcessing lead ${index + 1}/${leads.length}: ${fullName} (${leadEmail})`);

            if (leadEmail === 'no-email') {
                console.log(`Skipping lead ${fullName} as it has no email.`);
                continue;
            }

            if (Date.now() >= tokenExpirationTime) { // Verificar si el token ha expirado antes de cada operación
                console.log('Token expired, renewing...');
                accessToken = await getAccessToken(true);
            }

            let emails = await getEmailsOfLead('Leads', lead.id, accessToken);

            if (emails.length > 0) {
                const emailContents = [];
                for (const [emailIndex, email] of emails.entries()) {
                    console.log(`\nProcessing email ${emailIndex + 1}/${emails.length} for ${leadEmail}:`);
                    console.log(`Subject: ${email.subject}`);
                    console.log(`From: ${email.from}`);
                    console.log(`To: ${email.to}`);
                    console.log(`Sent: ${email.sentTime}`);

                    const emailContent = await getEmailContent('Leads', lead.id, email.messageId, accessToken);
                    const cleanedContent = cleanEmailContent(emailContent);

                    emailContents.push({
                        subject: email.subject,
                        from: email.from,
                        to: email.to,
                        content: cleanedContent,
                        sentTime: email.sentTime,
                    });

                    console.log(`Content of email ${emailIndex + 1}:\n${cleanedContent}\n`);
                }

                createPDF(fullName, emailContents, leadEmail);
                await processFileUpload(leadEmail, path.join(__dirname, 'emails-downloads', leadEmail, `emails-${sanitizeFileName(fullName)}.pdf`));
            } else {
                console.log(`No emails to display for lead: ${leadEmail}`);
            }

        } catch (error) {
            console.error(`Error processing lead ${fullName}:`, error.message);
        }

        saveProgress(leadEmail, lead.id); // Guardar progreso después de procesar cada lead
    }

    console.log('TRABAJO TERMINADO');
}

main();
