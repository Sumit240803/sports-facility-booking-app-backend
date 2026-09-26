import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

// Cloudflare R2 through its S3-compatible API
const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.r2.accessKeyId, secretAccessKey: env.r2.secretAccessKey },
});

// Public URL of an object (R2 custom domain or r2.dev URL)
export const publicUrl = (key: string): string => `${env.r2.publicUrl}/${key}`;

export const putObject = async (key: string, body: Buffer, contentType: string): Promise<void> => {
    await r2.send(new PutObjectCommand({
        Bucket: env.r2.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        // Keys are random and never overwritten, so files can be cached forever
        CacheControl: 'public, max-age=31536000, immutable',
    }));
};

export const deleteObject = async (key: string): Promise<void> => {
    await r2.send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }));
};
