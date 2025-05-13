FROM node:16-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy app files
COPY . .

# Ensure binaries are executable
RUN chmod +x ./bin/rhubarb

# Create directory for audio files
RUN mkdir -p audios

# Set the PORT environment variable
ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]
