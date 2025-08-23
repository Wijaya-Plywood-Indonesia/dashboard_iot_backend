# Gunakan official Node.js image
FROM node:20

# Set working directory
WORKDIR /app

# Copy package.json dan package-lock.json dulu (supaya cache efisien)
COPY package*.json ./

# Install dependencies (pakai npm ci kalau ada lockfile)
RUN npm ci --omit=dev || npm install --omit=dev

# Copy semua file project
COPY . .

# Generate Prisma Client (supaya @prisma/client bisa dipakai)
RUN npx prisma generate

# Railway otomatis inject ENV PORT, jadi pakai itu
ENV PORT=3000

# Expose port
EXPOSE 3000

# Jalankan aplikasi
CMD ["npm", "start"]
