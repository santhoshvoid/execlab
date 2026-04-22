FROM alpine:3.19

# Install g++ and Python (Python used as the wrapper script runner)
RUN apk add --no-cache g++ python3

# Non-root sandbox user
RUN addgroup -S sandbox && adduser -S sandbox -G sandbox

WORKDIR /sandbox
COPY run.py .

USER sandbox

ENTRYPOINT ["python3", "-u", "/sandbox/run.py"]