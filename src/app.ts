import dotenv from "dotenv";
import express from "express";
import routes from "./routes/index"; // 1. Import your routes

dotenv.config();

const app = express();

// 2. Add this middleware so Express can parse the JSON bodies from Postman
app.use(express.json());

// 3. Connect your routes to the app under the '/api' prefix
app.use("/api", routes);

const port = process.env.PORT || 3000;

app.listen(port, () => {
    console.log(`server running at port ${port}`);
});