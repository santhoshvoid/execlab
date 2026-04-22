FROM gcc:latest

WORKDIR /app

# create runner script
RUN echo '#!/bin/bash\n\
cat > main.cpp\n\
g++ main.cpp -o main.out 2> compile_error.txt\n\
if [ $? -ne 0 ]; then\n\
  cat compile_error.txt\n\
  exit 1\n\
fi\n\
./main.out\n\
' > run.sh && chmod +x run.sh

CMD ["./run.sh"]