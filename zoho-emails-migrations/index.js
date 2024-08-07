import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { htmlToText } from 'html-to-text';
import PDFDocument from 'pdfkit';
import moment from 'moment';

dotenv.config();

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const API_DOMAIN = process.env.API_DOMAIN || 'https://www.zohoapis.eu';

// Expresiones regulares para eliminar bloques de texto específicos
const CONFIDENTIALITY_NOTICE = [
    /CONFIDENTIALITY NOTICE:([\s\S]*?)(?=IMMUCURA LIMITED|$)/g,
    /IMMUCURA LIMITED([\s\S]*?)(?=(\n\n|\s*$))/g,
    /\[crm\\img_id:[^\]]*\]/g
];

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
        return response.data.access_token;
    } catch (error) {
        console.error('Error obtaining access token:', error.response ? error.response.data : error.message);
        return null;
    }
}

async function getFirstThreePatients(accessToken) {
    try {
        const response = await axios.get(`${API_DOMAIN}/crm/v3/PatientsNew`, {
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`
            },
            params: {
                fields: 'id,Name,Email',
                page: 1,
                per_page: 30
            }
        });
        return response.data.data;
    } catch (error) {
        console.error('Error fetching patients:', error.response ? error.response.data : error.message);
        return [];
    }
}

async function getEmailsOfPatient(moduleApiName, patientId, accessToken) {
    try {
        const url = `${API_DOMAIN}/crm/v3/${moduleApiName}/${patientId}/Emails`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`
            }
        });

        if (response.data && response.data.Emails) {
            return response.data.Emails.map(email => ({
                subject: email.subject,
                from: email.from.email,
                to: email.to.map(to => to.email).join(', '),
                messageId: email.message_id,
                content: email.content || 'No content available',
                sentTime: email.sent_time || 'No date available' // Get the sent time from the response
            }));
        } else {
            console.log('No emails found or no data available:', response.data);
            return [];
        }
    } catch (error) {
        console.error('Error fetching emails for patient:', error.response ? error.response.data : error.message);
        return [];
    }
}

async function getEmailContent(moduleApiName, patientId, messageId, accessToken) {
    try {
        const url = `${API_DOMAIN}/crm/v3/${moduleApiName}/${patientId}/Emails/${messageId}`;
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

// Remove confidentiality notices and unnecessary line breaks
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

// Function to create PDF files
function createPDF(patientName, emailContents, outputDir) {
    const doc = new PDFDocument();
    const outputFilePath = path.join(outputDir, `emails-${patientName}.pdf`);

    doc.pipe(fs.createWriteStream(outputFilePath));

    emailContents.forEach((content, index) => {
        if (index > 0) {
            doc.text('\n\n\n'); // Dejar tres espacios antes del siguiente correo
        }
        const sentTimeFormatted = moment(content.sent_time).format('MMMM Do YYYY, h:mm:ss a'); // Format the date using moment.js
        doc.fontSize(12).text(`MAIL ${index + 1}:\nSent: ${sentTimeFormatted}\nSubject: ${content.subject}\nFrom: ${content.from}\nTo: ${content.to}\n\nContent:\n${content.content}\n\n`, {
            align: 'left',
            lineGap: 2
        });
    });

    doc.end();
    console.log(`El correo ha sido guardado en '${outputFilePath}'.`);
}

async function main() {
    const accessToken = await getAccessToken();
    if (accessToken) {
        const patients = await getFirstThreePatients(accessToken);
        for (const patient of patients) {
            const fullName = patient.Name || 'Unknown Name';
            const patientEmail = patient.Email || 'no-email';
            console.log(`\nPatient: ${fullName}`);
            console.log(`Mail: ${patientEmail}`);
            console.log('List of emails:');

            const emails = await getEmailsOfPatient('PatientsNew', patient.id, accessToken);
            if (emails.length > 0) {
                const emailContents = [];
                for (const [index, email] of emails.entries()) {
                    console.log(`\nMail ${index + 1}:`);
                    console.log(`Subject: ${email.subject}`);
                    console.log(`From: ${email.from}`);
                    console.log(`To: ${email.to}`);
                    console.log(`Sent: ${email.sent_time}`);

                    // Intenta obtener el contenido del correo
                    const emailContent = await getEmailContent('PatientsNew', patient.id, email.messageId, accessToken);

                    // Limpiar y formatear contenido del correo
                    const cleanedContent = cleanEmailContent(emailContent);

                    emailContents.push({
                        subject: email.subject,
                        from: email.from,
                        to: email.to,
                        content: cleanedContent,
                        sentTime: email.sent_time
                    });

                    // Mostrar contenido limpio
                    console.log(`Content of mail ${index + 1}:\n${cleanedContent}\n`);
                }

                // Crear directorios si no existen
                const baseDir = path.join(__dirname, 'mails-downloads');
                const patientDir = path.join(baseDir, patientEmail);
                if (!fs.existsSync(baseDir)) {
                    fs.mkdirSync(baseDir);
                }
                if (!fs.existsSync(patientDir)) {
                    fs.mkdirSync(patientDir);
                }

                // Generar archivo PDF para este paciente
                createPDF(fullName, emailContents, patientDir);
            } else {
                console.log('No emails to display for this patient.');
            }
        }
    }
}

main();
