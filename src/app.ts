import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env.js";
import { openApiSpec } from "./docs/openapi.js";
import { webhook as razorpayWebhook } from "./controllers/payment.controller.js";
import { startNotificationsJob } from "./jobs/notifications.job.js";
import router from "./routes/index.js";
import { HttpError } from "./utils/http.js";

const app = express();

app.disable("x-powered-by");
// Razorpay webhook: raw body (signature is over the exact bytes), mounted before the JSON parser
app.post("/api/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }), razorpayWebhook);

app.use(express.json({ limit: "100kb" }));

// API docs: Swagger UI at /api/docs, raw spec at /api/openapi.json
app.get("/api/openapi.json", (_req: Request, res: Response) => { res.json(openApiSpec); });
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: "EasyPlay API" }));

app.use("/api", router);

app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
});

// Express 5 forwards rejected async handlers here
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }

    if (err instanceof multer.MulterError) {
        const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is too large" : err.message });
        return;
    }

    const e = err as { code?: string; message?: string; type?: string; status?: number };
    // Malformed JSON body / body too large (from express.json)
    if (e?.type === "entity.parse.failed") { res.status(400).json({ error: "Invalid JSON body" }); return; }
    if (e?.type === "entity.too.large") { res.status(413).json({ error: "Request body too large" }); return; }
    // Postgres unique violation, e.g. a phone number already used by another account
    if (e?.code === "23505") { res.status(409).json({ error: "Already in use" }); return; }
    // Postgres check constraint (last line of defence behind request validation)
    if (e?.code === "23514") { res.status(400).json({ error: "Invalid value" }); return; }
    // Business rule violations raised by our SQL functions/triggers (messages are user-facing)
    if (e?.code === "P0001") { res.status(409).json({ error: e.message }); return; }
    if (e?.code === "P0002") { res.status(404).json({ error: e.message }); return; }

    console.error(err);
    res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(env.port, () => {
    console.log(`server running at port ${env.port}`);
});
const stopJobs = startNotificationsJob();

// Graceful shutdown: stop jobs, finish in-flight requests
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        stopJobs();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10_000).unref();
    });
}
