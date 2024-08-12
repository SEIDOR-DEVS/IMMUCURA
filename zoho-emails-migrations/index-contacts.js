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

// Environment variables for Zoho CRM and Monday.com
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const API_DOMAIN = process.env.API_DOMAIN || 'https://www.zohoapis.eu';
const API_KEY = process.env.API_KEY;
const API_URL = process.env.API_URL;
const FILE_UPLOAD_URL = 'https://api.monday.com/v2/file';

// Expresiones regulares para eliminar bloques de texto específicos
const CONFIDENTIALITY_NOTICE = [
    /CONFIDENTIALITY NOTICE:([\s\S]*?)(?=IMMUCURA LIMITED|$)/g,
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
    /This message and its attachments are addressed exclusively([\s\S]*?)(?=(\n\n|\s*$))/gi
];

// Board and column mapping for Monday.com
const boardColumnMap = {
    1565914428: 'archivo4__1',
    1565676276: 'archivo7__1',
    1499741852: 'archivo1__1',
    1499741853: 'archivo8__1'
};

// Column mapping for email fields in Monday.com
const emailColumnMap = {
    1565914428: 'contact_email',
    1565676276: 'lead_email',
    1499741852: 'lead_email',
    1499741853: 'contact_email'
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

// Function to obtain the access token from Zoho
async function getAccessToken() {
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
            return response.data.access_token;
        } else {
            console.error('Unexpected response:', response.data);
            return null;
        }
    } catch (error) {
        if (error.response) {
            console.error('Error response data:', error.response.data);
        } else {
            console.error('Error obtaining access token:', error.message);
        }
        return null;
    }
}

// Function to get all contacts from Zoho with pagination
async function getAllContacts(accessToken) {
    let allContacts = [];
    let page = 1;
    let morePages = true;

    console.log('Fetching all contacts from Zoho CRM...');

    while (morePages) {
        try {
            const response = await axios.get(`${API_DOMAIN}/crm/v3/Contacts`, {
                headers: {
                    Authorization: `Zoho-oauthtoken ${accessToken}`
                },
                params: {
                    fields: 'id,Full_Name,Email',
                    page: page,
                    per_page: 200 // Adjust per page to handle more records at once
                }
            });

            const contacts = response.data.data;
            if (contacts.length > 0) {
                allContacts = allContacts.concat(contacts);
                console.log(`Page ${page} fetched with ${contacts.length} contacts.`);
                page++;
            } else {
                morePages = false;
                console.log('No more contacts to fetch.');
            }
        } catch (error) {
            console.error('Error fetching contacts:', error.response ? error.response.data : error.message);
            morePages = false;
        }
    }

    console.log(`Total contacts fetched: ${allContacts.length}`);
    return allContacts;
}

// Function to get emails of a specific contact from Zoho
async function getEmailsOfContact(moduleApiName, contactId, accessToken) {
    try {
        console.log(`Fetching emails for contact ID: ${contactId}`);
        const url = `${API_DOMAIN}/crm/v3/${moduleApiName}/${contactId}/Emails`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`
            }
        });

        if (response.data && response.data.Emails) {
            console.log(`Found ${response.data.Emails.length} emails for contact ID: ${contactId}`);
            return response.data.Emails.map(email => ({
                subject: email.subject,
                from: email.from.email,
                to: email.to.map(to => to.email).join(', '),
                messageId: email.message_id,
                content: email.content || 'No content available',
                sentTime: email.time || 'No date available' // Ensure you capture this date
            }));
        } else {
            console.log('No emails found or no data available:', response.data);
            return [];
        }
    } catch (error) {
        console.error('Error fetching emails for contact:', error.response ? error.response.data : error.message);
        return [];
    }
}

// Function to fetch the content of an email from Zoho
async function getEmailContent(moduleApiName, contactId, messageId, accessToken) {
    try {
        const url = `${API_DOMAIN}/crm/v3/${moduleApiName}/${contactId}/Emails/${messageId}`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`
            }
        });

        if (response.data && response.data.email_related_list && response.data.email_related_list.length > 0) {
            return response.data.email_related_list[0].content || 'No content available';
        } else {
            console.log('No email content found or no data available:', response.data);
            return 'No content available';
        }
    } catch (error) {
        console.error('Error fetching email content:', error.response ? error.response.data : error.message);
        return 'No content available';
    }
}

// Function to clean email content
function cleanEmailContent(content) {
    let cleanedContent = htmlToText(content, {
        wordwrap: 130,
        preserveNewlines: true
    });

    CONFIDENTIALITY_NOTICE.forEach(regex => {
        cleanedContent = cleanedContent.replace(regex, '');
    });

    // Reemplazar múltiples saltos de línea en la firma por un solo salto de línea
    cleanedContent = cleanedContent.replace(/(Mobile:.*?)(\n\s*?)(Email:.*?)(\n\s*?)(www\.immucura\.com.*?)(\n\s*?)(Immucura Limited.*?)(\n\s*?)(20 Harcourt Street,.*?)(\n\s*?)(Dublin 2, D02 H364)(\n\s*?)(T:.*?)(\n\s*?)(www\.immucura\.com)/g,
        '$1\n$3\n$5\n$7\n$9\n$11\n$13');

    // Eliminar saltos de línea múltiples en todo el contenido
    cleanedContent = cleanedContent.replace(/(\n\s*){3,}/g, '\n\n');

    return cleanedContent.trim();
}

// Function to create PDF files from emails
function createPDF(contactName, emailContents, outputDir) {
    const doc = new PDFDocument();
    const outputFilePath = path.join(outputDir, `emails-${contactName}.pdf`);

    doc.pipe(fs.createWriteStream(outputFilePath));

    emailContents.forEach((content, index) => {
        if (index > 0) {
            doc.text('\n\n\n'); // Dejar tres espacios antes del siguiente correo
        }
        const sentTimeFormatted = moment(content.sentTime).format('MMMM Do YYYY, h:mm:ss a'); // Use the sentTime from the email
        doc.fontSize(12).text(`MAIL ${index + 1}:\nSent: ${sentTimeFormatted}\nSubject: ${content.subject}\nFrom: ${content.from}\nTo: ${content.to}\n\nContent:\n${content.content}\n\n`, {
            align: 'left',
            lineGap: 2
        });
    });

    doc.end();
    console.log(`PDF created for contact: ${contactName}`);
}

// Function to find an item by email in Monday.com
async function findItemByEmail(boardIds, email) {
    if (!email) {
        throw new Error("Email is undefined");
    }

    const items = await Promise.all(boardIds.map(async boardId => {
        let allItems = [];
        let cursor = null;
        let moreItems = true;
        const emailColumnId = emailColumnMap[boardId]; // Get the correct email column ID

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
                    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds before retrying
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

// Function to upload and add a file to an item in Monday.com
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

// Function to process the file upload to Monday.com
async function processFileUpload(email, filePath) {
    const boardIds = Object.keys(boardColumnMap).map(Number);
    const items = await findItemByEmail(boardIds, email);

    if (items.length > 0) {
        console.log(`Email found in boards for ${email}:`, items);
        for (const item of items) {
            const columnId = boardColumnMap[item.boardId];
            if (columnId) {
                const fileName = path.basename(filePath);
                // Verificar si el archivo ya fue subido para este tablero y ítem
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
                    saveUploadedFiles(); // Guardar los archivos subidos después de cada subida
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

// Main function
async function main() {
    let accessToken = await getAccessToken();
    if (!accessToken) {
        console.log("Failed to obtain an access token.");
        process.exit(1);
    }

    const contacts = await getAllContacts(accessToken);
    console.log(`Processing ${contacts.length} contacts...`);

    for (const contact of contacts) {
        const fullName = contact.Full_Name || 'Unknown Name';
        const contactEmail = contact.Email || 'no-email';
        console.log(`\nProcessing contact: ${fullName} (${contactEmail})`);

        let emails = await getEmailsOfContact('Contacts', contact.id, accessToken);

        // Retry fetching emails if the token has expired
        if (emails.length === 0) {
            console.log('Retrying email fetch with refreshed token...');
            accessToken = await getAccessToken();
            emails = await getEmailsOfContact('Contacts', contact.id, accessToken);
        }

        if (emails.length > 0) {
            const emailContents = [];
            for (const [index, email] of emails.entries()) {
                console.log(`\nProcessing email ${index + 1} for ${contactEmail}:`);
                console.log(`Subject: ${email.subject}`);
                console.log(`From: ${email.from}`);
                console.log(`To: ${email.to}`);
                console.log(`Sent: ${email.sentTime}`);

                const emailContent = await getEmailContent('Contacts', contact.id, email.messageId, accessToken);
                const cleanedContent = cleanEmailContent(emailContent);

                emailContents.push({
                    subject: email.subject,
                    from: email.from,
                    to: email.to,
                    content: cleanedContent,
                    sentTime: email.sentTime // Ensure the sentTime is used correctly
                });

                console.log(`Content of email ${index + 1}:\n${cleanedContent}\n`);
            }

            const baseDir = path.join(__dirname, 'mails-downloads');
            const contactDir = path.join(baseDir, contactEmail);
            if (!fs.existsSync(baseDir)) {
                fs.mkdirSync(baseDir);
            }
            if (!fs.existsSync(contactDir)) {
                fs.mkdirSync(contactDir);
            }

            const pdfPath = path.join(contactDir, `emails-${fullName}.pdf`);
            createPDF(fullName, emailContents, contactDir);
            await processFileUpload(contactEmail, pdfPath);
        } else {
            console.log(`No emails to display for contact: ${contactEmail}`);
        }
    }
    console.log("TRABAJO TERMINADO");
    process.exit(0);
}

main();