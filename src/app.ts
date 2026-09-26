import express, { type NextFunction, type Request, type Response } from "express";
import { env } from "./config/env.js";
import router from "./routes/index.js";
import { HttpError } from "./utils/http.js";

const app = express();

app.use(express.json());

app.use("/api", router);

app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
});

// Express 5 forwards rejected async handlers here
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    // Postgres unique violation, e.g. a phone number already used by another account
    if ((err as { code?: string })?.code === '23505') { res.status(409).json({ error: 'Already in use' }); return; }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
});

app.listen(env.port, () => {
    console.log(`server running at port ${env.port}`);
});
