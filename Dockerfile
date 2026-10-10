FROM public.ecr.aws/docker/library/eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /workspace
COPY pom.xml mvnw mvnw.cmd ./
COPY .mvn .mvn
COPY src src
RUN chmod +x mvnw && ./mvnw package -Dmaven.test.skip=true
FROM public.ecr.aws/docker/library/eclipse-temurin:21-jre-alpine
RUN apk add --no-cache nodejs && addgroup -S spring && adduser -S spring -G spring
WORKDIR /app
COPY --from=builder /workspace/target/*.jar app.jar
COPY server.js cloudflare-turn.js turn-config.js turn-check.html container-start.sh ./
RUN chmod +x container-start.sh
USER spring:spring
ENV SPRING_PROFILES_ACTIVE=container SERVER_PORT=8080 PORT=3000 HOST=0.0.0.0 BACKEND_URL=http://127.0.0.1:8080
EXPOSE 3000
ENTRYPOINT ["/bin/sh","/app/container-start.sh"]
