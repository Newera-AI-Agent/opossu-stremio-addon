import { app } from './app.js';
const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'test')
    app.listen(port, () => console.log(`Opossu addon in ascolto sulla porta ${port}`));
