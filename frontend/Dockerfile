# Build stage
FROM node:18-alpine as build-stage

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

# Production stage
FROM nginx:alpine as production-stage

COPY --from=build-stage /app/dist /usr/share/nginx/html

# Update Nginx config to listen on 4000 instead of 80
RUN sed -i 's/listen       80;/listen       4000;/' /etc/nginx/conf.d/default.conf

EXPOSE 4000

CMD ["nginx", "-g", "daemon off;"]
