/** Lazily-constructed AWS SDK clients (endpoint override for LocalStack). */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';
import { STSClient } from '@aws-sdk/client-sts';
import type { Config } from '../../config.ts';

const clientConfig = (config: Config) => ({
  region: config.region,
  ...(config.awsEndpoint
    ? {
        endpoint: config.awsEndpoint,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }
    : {}),
});

let docClient: DynamoDBDocumentClient | undefined;
let s3Client: S3Client | undefined;
let sesClient: SESClient | undefined;
let stsClient: STSClient | undefined;

export const getDocClient = (config: Config): DynamoDBDocumentClient =>
  (docClient ??= DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig(config)), {
    marshallOptions: { removeUndefinedValues: true },
  }));

export const getS3Client = (config: Config): S3Client =>
  (s3Client ??= new S3Client({
    ...clientConfig(config),
    // LocalStack needs path-style; harmless against real AWS with virtual-host DNS.
    forcePathStyle: Boolean(config.awsEndpoint),
    // Default flexible checksums poison presigned PUT urls with a fixed
    // x-amz-checksum-crc32 the client's body can never match.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }));

export const getSesClient = (config: Config): SESClient =>
  (sesClient ??= new SESClient(clientConfig(config)));

/** AssumeRole for role-mode storage pools (H2, D55). */
export const getStsClient = (config: Config): STSClient =>
  (stsClient ??= new STSClient(clientConfig(config)));
