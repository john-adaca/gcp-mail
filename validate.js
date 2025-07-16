import net from "net";
import dns from "dns/promises";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Papa from "papaparse";
import { log } from "./src/common/logger";
import {
  generateEmailFromPattern,
  inferPatternFromEmail,
} from "./src/common/helpers";

const SMTP_TIMEOUT = 30000;
const UPLOAD_DIR = "./uploads";
const RESULTS_DIR = "./results";

// Global pattern storage for domains
const domainPatterns = new Map();

// Ensure directories exist
await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(RESULTS_DIR, { recursive: true });

// In-memory store for file processing status
const fileJobs = new Map();

export async function validateEmail(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const { email, timeout = 30000 } =
      req.method === "POST" ? req.body : req.query;

    if (!email) {
      log("warn", "Email validation failed: missing email parameter", {
        method: req.method,
        ip: req.ip || req.connection.remoteAddress,
      });
      return res
        .status(400)
        .json({ success: false, error: "Email parameter is required" });
    }

    log("info", "Starting email validation", {
      email,
      timeout,
      method: req.method,
      ip: req.ip || req.connection.remoteAddress,
    });

    const domain = email.split("@")[1];
    if (!domain) {
      log("warn", "Email validation failed: invalid format", {
        email,
        ip: req.ip || req.connection.remoteAddress,
      });
      return res
        .status(400)
        .json({ success: false, error: "Invalid email format" });
    }

    log("info", "Email format validated", { email, domain });

    const mxServers = await getMXServers(domain);

    if (mxServers.length === 0) {
      log("warn", "No MX records found", { email, domain });
      return res.json({
        success: false,
        email,
        domain,
        error: "No MX records found for domain",
      });
    }

    let result = false;
    let lastError = "";

    for (const mxServer of mxServers) {
      try {
        log("info", "Testing MX server", { mxServer, email });
        result = await testSmtpConnection(mxServer, email);
        if (result) {
          log("info", "Email validated successfully", {
            email,
            domain,
            mxServer,
            validationResult: true,
          });

          // Store pattern when email validates successfully
          const pattern = inferPatternFromEmail(email);
          domainPatterns.set(domain, pattern);
          log("info", "Pattern stored from successful validation", {
            domain,
            email,
            pattern,
          });

          break;
        }
      } catch (error) {
        lastError = error.message;
        log("warn", "MX server test failed", {
          mxServer,
          email,
          error: error.message,
        });
      }
    }

    const response = {
      success: result,
      email,
      domain,
      mxServers,
      pattern: domainPatterns.get(domain) || "unknown",
      error: result ? null : lastError || "No SMTP servers responded",
    };

    log("info", "Email validation completed", {
      email,
      domain,
      success: result,
      error: response.error,
      processingTime: Date.now() - req.startTime,
    });

    res.json(response);
  } catch (error) {
    log("error", "Email validation error", {
      error: error.message,
      stack: error.stack,
      ip: req.ip || req.connection.remoteAddress,
    });
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function validateBatch(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const fileId = uuidv4();
    let emails = [];
    let employees = [];
    let domain = null;
    let isEmployeeValidation = false;

    // Check if it's employee validation or CSV upload
    if (req.body.employees && req.body.domain) {
      // Employee validation mode
      employees = req.body.employees;
      domain = req.body.domain;
      isEmployeeValidation = true;

      log("info", "Employee validation mode", {
        fileId,
        totalEmployees: employees.length,
        domain,
        existingPattern: domainPatterns.get(domain),
      });
    } else {
      // CSV upload mode
      const file = req.file || req.body.file;
      const emailColumn = req.body.email_address_column || "1";
      const hasHeader = req.body.has_header_row === "true";
      const removeDuplicates = req.body.remove_duplicate === "true";

      if (!file) {
        return res.status(400).json({
          success: false,
          error: "No file uploaded or employees provided",
        });
      }

      const uploadPath = path.join(UPLOAD_DIR, `${fileId}.csv`);

      // Save uploaded file
      let csvContent;
      if (typeof file === "string") {
        csvContent = file;
      } else if (file.buffer) {
        csvContent = file.buffer.toString();
      } else {
        csvContent = await fs.readFile(file.path, "utf8");
      }

      await fs.writeFile(uploadPath, csvContent);

      // Parse CSV to extract emails
      emails = await extractEmailsFromCSV(
        uploadPath,
        emailColumn,
        hasHeader,
        removeDuplicates
      );

      // Try to detect domain patterns from the email list
      const domainPatternMap = new Map();

      for (const email of emails) {
        const emailDomain = email.split("@")[1];

        if (!domainPatternMap.has(emailDomain)) {
          const pattern = inferPatternFromEmail(email);
          domainPatternMap.set(emailDomain, pattern);
        }
      }

      // Store detected patterns globally if not already stored
      domainPatternMap.forEach((pattern, emailDomain) => {
        if (!domainPatterns.has(emailDomain)) {
          domainPatterns.set(emailDomain, pattern);
          log("info", "Domain pattern inferred from CSV", {
            domain: emailDomain,
            pattern,
          });
        }
      });

      log("info", "CSV upload mode", {
        fileId,
        totalEmails: emails.length,
        emailColumn,
        hasHeader,
        removeDuplicates,
      });
    }

    // Initialize job status
    fileJobs.set(fileId, {
      fileId,
      status: "processing",
      totalEmails: isEmployeeValidation ? employees.length : emails.length,
      processedEmails: 0,
      validEmails: 0,
      invalidEmails: 0,
      uploadedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    });

    // Start processing asynchronously
    if (isEmployeeValidation) {
      processBatchValidationWithPatterns(fileId, employees, domain);
    } else {
      processBatchValidation(fileId, emails);
    }

    res.json({
      success: true,
      file_id: fileId,
      message: isEmployeeValidation
        ? "Employee validation started"
        : "File uploaded and processing started",
    });
  } catch (error) {
    log("error", "Batch validation error", {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function fileStatus(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const fileId = req.query.file_id;

    if (!fileId) {
      return res.status(400).json({
        success: false,
        error: "file_id parameter is required",
      });
    }

    const job = fileJobs.get(fileId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "File not found",
      });
    }

    const response = {
      success: true,
      file_id: fileId,
      file_status: job.status,
      downloadable: job.status === "complete",
      total_emails: job.totalEmails,
      processed_emails: job.processedEmails,
      valid_emails: job.validEmails,
      invalid_emails: job.invalidEmails,
      progress_percentage:
        job.totalEmails > 0
          ? Math.round((job.processedEmails / job.totalEmails) * 100)
          : 0,
      uploaded_at: job.uploadedAt,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      error: job.error,
    };

    log("info", "File status checked", {
      fileId,
      status: job.status,
      progress: response.progress_percentage,
    });

    res.json(response);
  } catch (error) {
    log("error", "File status check error", {
      error: error.message,
      fileId: req.query.file_id,
    });
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function downloadFile(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const fileId = req.query.file_id;

    if (!fileId) {
      return res.status(400).json({
        success: false,
        error: "file_id parameter is required",
      });
    }

    const job = fileJobs.get(fileId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "File not found",
      });
    }

    if (job.status !== "complete") {
      return res.status(400).json({
        success: false,
        error: `File is not ready for download. Current status: ${job.status}`,
      });
    }

    const resultPath = path.join(RESULTS_DIR, `${fileId}_results.csv`);

    try {
      await fs.access(resultPath);
    } catch {
      return res.status(404).json({
        success: false,
        error: "Result file not found",
      });
    }

    log("info", "File download requested", { fileId });

    res.set("Content-Type", "text/csv");
    res.set(
      "Content-Disposition",
      `attachment; filename="validation_results_${fileId}.csv"`
    );

    const fileStream = await fs.readFile(resultPath);
    res.send(fileStream);
  } catch (error) {
    log("error", "File download error", {
      error: error.message,
      fileId: req.query.file_id,
    });
    res.status(500).json({ success: false, error: error.message });
  }
}

// Helper function to extract emails from CSV
async function extractEmailsFromCSV(
  filePath,
  emailColumn,
  hasHeader,
  removeDuplicates
) {
  const csvContent = await fs.readFile(filePath, "utf8");

  return new Promise((resolve, reject) => {
    Papa.parse(csvContent, {
      header: false,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          let data = results.data;

          if (hasHeader && data.length > 0) {
            data = data.slice(1);
          }

          const columnIndex = parseInt(emailColumn) - 1;
          let emails = data
            .map((row) => row[columnIndex])
            .filter((email) => email && email.includes("@"));

          if (removeDuplicates) {
            emails = [...new Set(emails.map((email) => email.toLowerCase()))];
          }

          resolve(emails);
        } catch (error) {
          reject(error);
        }
      },
      error: (error) => {
        reject(error);
      },
    });
  });
}

// Background processing function for CSV emails
async function processBatchValidation(fileId, emails) {
  const job = fileJobs.get(fileId);
  const maxConcurrent = 3;
  const results = [];

  try {
    log("info", "Starting batch processing", {
      fileId,
      totalEmails: emails.length,
    });

    for (let i = 0; i < emails.length; i += maxConcurrent) {
      const batch = emails.slice(i, i + maxConcurrent);

      const batchResults = await Promise.all(
        batch.map(async (email) => {
          try {
            const domain = email.split("@")[1];
            const mxServers = await getMXServers(domain);
            let valid = false;
            let error = "";

            if (mxServers.length === 0) {
              error = "No MX records found";
            } else {
              for (const mxServer of mxServers) {
                try {
                  valid = await testSmtpConnection(mxServer, email);
                  if (valid) {
                    // Store pattern when email validates successfully
                    const pattern = inferPatternFromEmail(email);
                    domainPatterns.set(domain, pattern);
                    log(
                      "info",
                      "Pattern confirmed from successful validation",
                      {
                        domain,
                        email,
                        pattern,
                      }
                    );
                    break;
                  }
                } catch (err) {
                  error = err.message;
                }
              }
            }

            job.processedEmails++;
            if (valid) {
              job.validEmails++;
            } else {
              job.invalidEmails++;
            }

            return {
              email,
              status: valid ? "valid" : "invalid",
              error: valid ? "" : error,
              domain,
              pattern: domainPatterns.get(domain) || "unknown",
              mxServers: mxServers.join(", "),
              processed_at: new Date().toISOString(),
            };
          } catch (err) {
            job.processedEmails++;
            job.invalidEmails++;
            return {
              email,
              status: "invalid",
              error: err.message,
              domain: "",
              pattern: "unknown",
              mxServers: "",
              processed_at: new Date().toISOString(),
            };
          }
        })
      );

      results.push(...batchResults);

      if (i + maxConcurrent < emails.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const resultPath = path.join(RESULTS_DIR, `${fileId}_results.csv`);
    const csvData = Papa.unparse(results, {
      header: true,
      columns: [
        "email",
        "status",
        "error",
        "domain",
        "pattern",
        "mxServers",
        "processed_at",
      ],
    });

    await fs.writeFile(resultPath, csvData);

    job.status = "complete";
    job.completedAt = new Date().toISOString();

    log("info", "Batch processing completed", {
      fileId,
      totalEmails: emails.length,
      validEmails: job.validEmails,
      invalidEmails: job.invalidEmails,
      processingTime: new Date() - new Date(job.startedAt),
    });
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.completedAt = new Date().toISOString();

    log("error", "Batch processing failed", {
      fileId,
      error: error.message,
    });
  }
}

// Background processing function for employee validation with patterns
async function processBatchValidationWithPatterns(fileId, employees, domain) {
  const job = fileJobs.get(fileId);
  const maxConcurrent = 3;
  const results = [];
  let detectedPattern = domainPatterns.get(domain);

  try {
    log("info", "Starting employee batch processing with patterns", {
      fileId,
      totalEmployees: employees.length,
      domain,
      existingPattern: detectedPattern,
    });

    for (let i = 0; i < employees.length; i += maxConcurrent) {
      const batch = employees.slice(i, i + maxConcurrent);

      const batchResults = await Promise.all(
        batch.map(async (employee) => {
          try {
            let email;
            let valid = false;
            let error = "";

            if (detectedPattern) {
              // Use detected pattern
              email = generateEmailFromPattern(
                employee.firstName,
                employee.lastName,
                domain,
                detectedPattern
              );

              const mxServers = await getMXServers(domain);
              if (mxServers.length === 0) {
                error = "No MX records found";
              } else {
                for (const mxServer of mxServers) {
                  try {
                    valid = await testSmtpConnection(mxServer, email);
                    if (valid) break;
                  } catch (err) {
                    error = err.message;
                  }
                }
              }
            } else {
              // Try different patterns until we find one that works
              const patterns = [
                "firstname",
                "firstname.lastname",
                "firstnamelastname",
                "f.lastname",
                "flastname",
              ];
              const mxServers = await getMXServers(domain);

              if (mxServers.length === 0) {
                error = "No MX records found";
              } else {
                for (const pattern of patterns) {
                  const testEmail = generateEmailFromPattern(
                    employee.firstName,
                    employee.lastName,
                    domain,
                    pattern
                  );

                  for (const mxServer of mxServers) {
                    try {
                      const testResult = await testSmtpConnection(
                        mxServer,
                        testEmail
                      );
                      if (testResult) {
                        // Found the pattern!
                        detectedPattern = pattern;
                        domainPatterns.set(domain, pattern);
                        email = testEmail;
                        valid = true;

                        log("info", "Email pattern detected", {
                          domain,
                          pattern,
                          testEmail,
                          employee: employee.name,
                        });

                        break;
                      }
                    } catch (err) {
                      error = err.message;
                    }
                  }

                  if (valid) break;
                }
              }
            }

            job.processedEmails++;
            if (valid) {
              job.validEmails++;
            } else {
              job.invalidEmails++;
            }

            return {
              name: employee.name,
              firstName: employee.firstName,
              lastName: employee.lastName,
              position: employee.position,
              email: email || "not_found",
              status: valid ? "valid" : "invalid",
              error: valid ? "" : error,
              domain: domain,
              pattern: detectedPattern || "unknown",
              processed_at: new Date().toISOString(),
            };
          } catch (err) {
            job.processedEmails++;
            job.invalidEmails++;
            return {
              name: employee.name,
              firstName: employee.firstName,
              lastName: employee.lastName,
              position: employee.position,
              email: "error",
              status: "invalid",
              error: err.message,
              domain: domain,
              pattern: "unknown",
              processed_at: new Date().toISOString(),
            };
          }
        })
      );

      results.push(...batchResults);

      if (i + maxConcurrent < employees.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const resultPath = path.join(RESULTS_DIR, `${fileId}_results.csv`);
    const csvData = Papa.unparse(results, {
      header: true,
      columns: [
        "name",
        "firstName",
        "lastName",
        "position",
        "email",
        "status",
        "error",
        "domain",
        "pattern",
        "processed_at",
      ],
    });

    await fs.writeFile(resultPath, csvData);

    job.status = "complete";
    job.completedAt = new Date().toISOString();

    log("info", "Employee batch processing completed", {
      fileId,
      totalEmployees: employees.length,
      validEmails: job.validEmails,
      invalidEmails: job.invalidEmails,
      detectedPattern,
      domain,
      processingTime: new Date() - new Date(job.startedAt),
    });
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.completedAt = new Date().toISOString();

    log("error", "Employee batch processing failed", {
      fileId,
      error: error.message,
    });
  }
}

async function getMXServers(domain) {
  try {
    log("debug", "Looking up MX records", { domain });

    const mxRecords = await dns.resolveMx(domain);
    const sortedServers = mxRecords
      .sort((a, b) => a.priority - b.priority)
      .map((record) => record.exchange);

    log("debug", "MX records found", {
      domain,
      mxRecords: mxRecords.map((r) => `${r.exchange} (${r.priority})`),
      sortedServers,
    });

    return sortedServers;
  } catch (error) {
    log("warn", "MX lookup failed", { domain, error: error.message });

    const fallbackServers = [
      `smtp.${domain}`,
      `mail.${domain}`,
      `mx.${domain}`,
      `mx1.${domain}`,
    ];

    log("debug", "Using fallback MX servers", { domain, fallbackServers });
    return fallbackServers;
  }
}

async function testSmtpConnection(mxServer, targetEmail) {
  const sender = "noreply@adaca.com";
  const domain = sender.split("@")[1];
  const ports = [25];

  log("debug", "Starting SMTP connection test", {
    mxServer,
    targetEmail,
    sender,
    ports,
  });

  for (const port of ports) {
    try {
      log("debug", "Attempting SMTP connection", {
        mxServer,
        port,
        targetEmail,
      });

      const result = await new Promise((resolve, reject) => {
        const socket = net.createConnection(port, mxServer);
        socket.setTimeout(SMTP_TIMEOUT);

        const commands = [
          `EHLO ${domain}\r\n`,
          `MAIL FROM:<${sender}>\r\n`,
          `RCPT TO:<${targetEmail}>\r\n`,
          `QUIT\r\n`,
        ];

        let step = -1;
        let success = false;
        let resolved = false;
        let buffer = "";

        const sendNext = () => {
          step++;
          if (step < commands.length) {
            socket.write(commands[step]);
          } else {
            socket.end();
          }
        };

        const handleResponse = (line) => {
          const code = parseInt(line.substring(0, 3), 10);
          if (isNaN(code)) return;

          if (step === -1 && code === 220) {
            sendNext();
          } else if (step === 2) {
            // Enhanced RCPT TO response analysis
            if (code === 250 || code === 251) {
              if (
                line.includes("undeliverable") ||
                line.includes("does not exist") ||
                line.includes("invalid recipient") ||
                line.includes("user unknown") ||
                line.includes("mailbox unavailable")
              ) {
                success = false;
              } else {
                success = true;
              }
            } else if (code === 550 || code === 551 || code === 553) {
              success = false;
            } else {
              success = code >= 200 && code < 300;
            }
            sendNext();
          } else if (code >= 200 && code < 300) {
            sendNext();
          } else {
            socket.end();
          }
        };

        const finish = (result, error) => {
          if (!resolved) {
            resolved = true;
            socket.destroy();
            if (error) {
              log("debug", "SMTP connection failed", {
                mxServer,
                port,
                targetEmail,
                error,
              });
              reject(new Error(error));
            } else {
              log("debug", "SMTP connection result", {
                mxServer,
                port,
                targetEmail,
                success: result,
              });
              resolve(result);
            }
          }
        };

        socket.on("data", (data) => {
          buffer += data.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line && !/^\d{3}-/.test(line)) {
              handleResponse(line);
            }
          }
        });

        socket.on("timeout", () =>
          finish(false, `Timeout after ${SMTP_TIMEOUT}ms`)
        );
        socket.on("error", (err) =>
          finish(false, `Socket error: ${err.message} (${err.code})`)
        );
        socket.on("end", () => finish(success));
        socket.on("close", () => finish(success));
      });

      if (result) {
        log("debug", "SMTP validation successful", {
          mxServer,
          port,
          targetEmail,
        });
        return result;
      }
    } catch (error) {
      log("debug", "SMTP connection attempt failed", {
        mxServer,
        port,
        targetEmail,
        error: error.message,
      });
      continue;
    }
  }

  log("debug", "All SMTP connection attempts failed", {
    mxServer,
    targetEmail,
    testedPorts: ports,
  });

  return false;
}

export async function testNetworkConnectivity(req, res) {
  const testResults = {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      cloudRun: !!process.env.PORT,
      vpc: !!process.env.VPC_CONNECTOR_NAME,
    },
    tests: [],
  };

  const testServers = [
    { server: "smtp.gmail.com", ports: [25, 587, 465] },
    { server: "smtp.outlook.com", ports: [25, 587] },
    { server: "aspmx.l.google.com", ports: [25] },
  ];

  for (const { server, ports } of testServers) {
    for (const port of ports) {
      try {
        const result = await testPortConnectivity(server, port, 5000);
        testResults.tests.push({
          server,
          port,
          success: result,
          error: result ? null : "Connection failed",
        });

        log("info", "Network connectivity test", {
          server,
          port,
          success: result,
        });
      } catch (error) {
        testResults.tests.push({
          server,
          port,
          success: false,
          error: error.message,
        });

        log("warn", "Network connectivity test failed", {
          server,
          port,
          error: error.message,
        });
      }
    }
  }

  try {
    const mxRecords = await getMXServers("gmail.com");
    testResults.dnsTest = {
      success: mxRecords.length > 0,
      mxRecords,
    };
  } catch (error) {
    testResults.dnsTest = {
      success: false,
      error: error.message,
    };
  }

  log("info", "Network connectivity test completed", testResults);
  res.json(testResults);
}

async function testPortConnectivity(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    socket.setTimeout(timeout);

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
