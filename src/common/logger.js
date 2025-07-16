export const log = (level, message, metadata = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...metadata,
  };
  console.log(JSON.stringify(logEntry));
};
