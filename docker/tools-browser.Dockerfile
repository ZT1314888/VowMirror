FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /opt/browser
RUN npm install --no-audit --no-fund --save-exact playwright@1.56.1
WORKDIR /workspace
