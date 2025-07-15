# Use Node.js 18 base image
FROM node:18

# Create and set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json if exists
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy app source code
COPY . .

# Expose port 8080
EXPOSE 8080

# Start your app
CMD ["node", "index.js"]
