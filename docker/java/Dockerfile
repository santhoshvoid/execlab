FROM eclipse-temurin:17-jdk-alpine

# Install Python for the wrapper script
RUN apk add --no-cache python3

# Non-root sandbox user
RUN addgroup -S sandbox && adduser -S sandbox -G sandbox

WORKDIR /sandbox
COPY run.py .

USER sandbox

ENTRYPOINT ["python3", "-u", "/sandbox/run.py"]