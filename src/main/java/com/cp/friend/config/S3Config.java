package com.cp.friend.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;

import java.net.URI;

@Configuration
public class S3Config {

    @Value("${AWS_ENDPOINT_URL_S3:http://localhost:9000}")
    private String endpoint;

    @Value("${AWS_ACCESS_KEY_ID:test-access-key}")
    private String accessKey;

    @Value("${AWS_SECRET_ACCESS_KEY:test-secret-key}")
    private String secretKey;

    @Value("${AWS_REGION:us-east-1}")
    private String region;

    @Value("${AWS_PUBLIC_URL_S3:${AWS_ENDPOINT_URL_S3}}")
    private String publicEndpoint;

    public String getPublicEndpoint() { return publicEndpoint == null ? endpoint : publicEndpoint; }

    public String getEndpoint() {
        return endpoint;
    }

    @Bean
    public S3Client s3Client() {

        AwsBasicCredentials credentials =
                AwsBasicCredentials.create(
                        accessKey,
                        secretKey
                );

        return S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.of(region))
                .credentialsProvider(
                        StaticCredentialsProvider.create(credentials)
                )
                .forcePathStyle(true)
                .build();
    }
}