// validate.js

import net from "net";
import dns from "dns/promises";

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

const SMTP_TIMEOUT = 30000;

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

    // Get actual MX records instead of guessing
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

export async function validateEmailBatch(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const { emails, timeout = 30000, maxConcurrent = 5 } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
      log("warn", "Batch validation failed: invalid emails array", {
        emailsType: typeof emails,
        emailsLength: Array.isArray(emails) ? emails.length : "not array",
        ip: req.ip || req.connection.remoteAddress,
      });
      return res
        .status(400)
        .json({ success: false, error: "emails array is required" });
    }

    log("info", "Starting batch email validation", {
      emailCount: emails.length,
      timeout,
      maxConcurrent,
      ip: req.ip || req.connection.remoteAddress,
    });

    const results = [];

    for (let i = 0; i < emails.length; i += maxConcurrent) {
      const batch = emails.slice(i, i + maxConcurrent);
      const batchNumber = Math.floor(i / maxConcurrent) + 1;
      const totalBatches = Math.ceil(emails.length / maxConcurrent);

      log("info", "Processing batch", {
        batchNumber,
        totalBatches,
        batchSize: batch.length,
        startIndex: i,
      });

      const batchResults = await Promise.all(
        batch.map(async (email) => {
          try {
            const domain = email.split("@")[1];
            const mxServers = await getMXServers(domain);
            let success = false;
            let error = "";

            log("debug", "Processing email in batch", {
              email,
              domain,
              mxServers,
            });

            if (mxServers.length === 0) {
              return { email, valid: false, error: "No MX records found" };
            }

            for (const mxServer of mxServers) {
              try {
                success = await testSmtpConnection(mxServer, email);
                if (success) {
                  log("debug", "Email validated in batch", { email, mxServer });
                  break;
                }
              } catch (err) {
                error = err.message;
                log("debug", "Email validation failed in batch", {
                  email,
                  mxServer,
                  error: err.message,
                });
              }
            }

            return { email, valid: success, error: success ? null : error };
          } catch (err) {
            log("warn", "Email processing error in batch", {
              email,
              error: err.message,
            });
            return { email, valid: false, error: err.message };
          }
        })
      );

      results.push(...batchResults);

      log("info", "Batch completed", {
        batchNumber,
        processedCount: batchResults.length,
        validCount: batchResults.filter((r) => r.valid).length,
      });

      if (i + maxConcurrent < emails.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const validCount = results.filter((r) => r.valid).length;
    const invalidCount = emails.length - validCount;

    const response = {
      success: true,
      totalProcessed: emails.length,
      validEmails: validCount,
      invalidEmails: invalidCount,
      results,
    };

    log("info", "Batch validation completed", {
      totalProcessed: emails.length,
      validEmails: validCount,
      invalidEmails: invalidCount,
      successRate: ((validCount / emails.length) * 100).toFixed(2) + "%",
      processingTime: Date.now() - req.startTime,
    });

    res.json(response);
  } catch (error) {
    log("error", "Batch validation error", {
      error: error.message,
      stack: error.stack,
      ip: req.ip || req.connection.remoteAddress,
    });
    res.status(500).json({ success: false, error: error.message });
  }
}

// NEW FUNCTION: Get actual MX records for a domain
async function getMXServers(domain) {
  try {
    log("debug", "Looking up MX records", { domain });

    const mxRecords = await dns.resolveMx(domain);

    // Sort by priority (lower number = higher priority)
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

    // Fallback to common server names if MX lookup fails
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
  const ports = [25, 587, 465];

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
            success = code === 250 || code === 251;
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

// Network connectivity test endpoint
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

  // Test common SMTP servers
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

  // Test DNS resolution
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

// Helper function to test port connectivity
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
