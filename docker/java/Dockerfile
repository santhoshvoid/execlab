FROM eclipse-temurin:17

WORKDIR /app

RUN echo '#!/bin/bash\n\
cat > Main.java\n\
javac Main.java 2> compile_error.txt\n\
if [ $? -ne 0 ]; then\n\
  cat compile_error.txt\n\
  exit 1\n\
fi\n\
java Main\n\
' > run.sh && chmod +x run.sh

CMD ["./run.sh"]