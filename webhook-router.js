const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PROJECT1_URL = 'http://localhost:3001';
const PROJECT2_URL = 'http://localhost:3002';

app.post('/webhook', async (req, res) => {
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));

    if (req.body.challenge) {
        console.log('Responding to challenge:', req.body.challenge);
        return res.status(200).json({ challenge: req.body.challenge });
    }

    if (!req.body.event) {
        console.error('No event found in payload');
        return res.status(400).send('Invalid payload');
    }

    const { boardId } = req.body.event;

    let targetUrl;
    if (boardId === 1525879275) {
        targetUrl = PROJECT1_URL;
    } else if (boardId === 1556224598) {
        targetUrl = PROJECT2_URL;
    } else {
        return res.status(400).send('Unknown boardId');
    }

    try {
        const response = await axios.post(`${targetUrl}/webhook`, req.body);
        res.status(response.status).send(response.data);
    } catch (error) {
        console.error('Error forwarding webhook:', error.message);
        res.status(500).send('Error forwarding webhook');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Webhook router listening on port ${PORT}`);
});
