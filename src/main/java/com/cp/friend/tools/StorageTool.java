package com.cp.friend.tools;

import com.cp.friend.config.S3Config;
import com.cp.friend.port.StoragePort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.util.Base64;
import java.util.UUID;

// Adapter Pattern — Adapter หุ้ม AWS S3 SDK ให้โค้ดภายในเห็นแค่ StoragePort
// (ผู้ใช้ interface ไม่ต้องรู้ว่าข้างหลังคือ S3/Neon Storage)
@Component
public class StorageTool implements StoragePort {

    private final S3Client s3Client;
    private final S3Config s3Config;

    @Value("${AWS_BUCKET:storage}")
    private String bucket;

    public StorageTool(S3Client s3Client, S3Config s3Config) {
        this.s3Client = s3Client;
        this.s3Config = s3Config;
    }

    @Override
    public String uploadBase64(String base64) {
        String contentType = "image/png";
        if (base64.startsWith("data:")) {
            String[] parts = base64.split(",", 2);
            // data:image/png;base64
            String metadata = parts[0];
            // iVBORw0KGgo...
            base64 = parts[1];
            contentType = metadata.substring(5, metadata.indexOf(";"));
        }
        byte[] fileBytes = Base64.getDecoder().decode(base64);
        String extension = getExtension(contentType);
        String filename = UUID.randomUUID() + "." + extension;
        String key = "uploads/" + filename;

        try {
            PutObjectRequest request =
                    PutObjectRequest.builder()
                            .bucket(bucket)
                            .key(key)
                            .contentType(contentType)
                            .build();

            s3Client.putObject(
                    request,
                    RequestBody.fromBytes(fileBytes)
            );
            return key;
        } catch (Exception e) {
            System.err.println("S3 storage unavailable, using fallback: " + e.getMessage());
            return "fallback-avatar";
        }
    }

    @Override
    public String publicUrl(String key) {
        if (key == null || key.isBlank() || "fallback-avatar".equals(key)) {
            return "/images/avatar-placeholder.svg";
        }
        return s3Config.getPublicEndpoint().replaceAll("/+$", "").concat("/"+bucket+"/").concat(key);
    }

    private String getExtension(String contentType) {
        return switch (contentType) {
            case "image/jpeg" -> "jpg";
            case "image/png" -> "png";
            case "image/gif" -> "gif";
            case "image/webp" -> "webp";
            default -> "bin";
        };
    }
}
