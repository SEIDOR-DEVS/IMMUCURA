const express = require('express');
const app = express();
const port = 3000;

// Ruta para manejar el callback de OAuth
app.get('/', (req, res) => {
    const authCode = req.query.code;
    if (!authCode) {
        res.status(400).send('No auth code received');
    } else {
        res.send(`Auth code received: ${authCode}`);
        // Aquí puedes seguir con el proceso para obtener el token de acceso usando el código de autorización
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
