// index.js

import express from "express";
import bodyParser from "body-parser";
import { validateEmail, validateEmailBatch } from "./validate.js";

const log = (level, message, metadata = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...metadata,
  };
  console.log(JSON.stringify(logEntry));
};

const app = express();

app.use((req, res, next) => {
  req.startTime = Date.now();
  log("info", "Incoming request", {
    method: req.method,
    url: req.url,
    userAgent: req.get("User-Agent"),
    ip: req.ip || req.connection.remoteAddress,
  });
  next();
});

app.use(bodyParser.json());

// Routes
app.post("/validateEmail", validateEmail);
app.post("/validateEmailBatch", validateEmailBatch);

// Health check
app.get("/", (req, res) => {
  log("info", "Health check accessed");
  res.send("✅ Email Validator is running.");
});

// Start server on Cloud Run default port
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  log("info", "Server started", {
    port: PORT,
    environment: process.env.NODE_ENV || "development",
    nodeVersion: process.version,
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("info", "SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("info", "SIGINT received, shutting down gracefully");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  log("error", "Unhandled rejection", {
    reason: reason?.message || reason,
    stack: reason?.stack,
  });
});
