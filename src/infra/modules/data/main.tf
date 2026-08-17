/**
 * The stateful half: the single table and the objects bucket.
 * Everything here carries prevent_destroy (pattern inherited from
 * immich-serverless infra-tofu — it earned its keep on the first deploy).
 *
 * Storage classes (build plan §1, GIR-only decision 2026-08-16):
 *  - originals -> GLACIER_IR at day 0, selected by OBJECT TAG tier=original.
 *    A prefix rule is impossible: museum's key layout puts originals and
 *    thumbnails under the same `userID/uuid` prefix, so the API tags the
 *    original at commit time instead.
 *  - thumbnails (untagged) and file-data (`userID/file-data/...`) stay
 *    Standard — the grid reads thumbs constantly, HLS needs hot segments.
 *  - NO Deep Archive anywhere. No restore workflow exists, by design.
 */

data "aws_caller_identity" "current" {}

locals {
  prefix = "ente-sl-${var.env_name}"
  suffix = data.aws_caller_identity.current.account_id
}

resource "aws_dynamodb_table" "this" {
  name                        = local.prefix
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  attribute {
    name = "gsi2pk"
    type = "S"
  }
  attribute {
    name = "gsi2sk"
    type = "S"
  }
  attribute {
    name = "gsi3pk"
    type = "S"
  }
  attribute {
    name = "gsi3sk"
    type = "S"
  }

  # gsi1: collection-file diff feed + trash purge due-index
  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }
  # gsi2: per-user collection change feed
  global_secondary_index {
    name            = "gsi2"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi2pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi2sk"
      key_type       = "RANGE"
    }
  }
  # gsi3: tokens per user, trash diff, entity diff, file-data status diff
  global_secondary_index {
    name            = "gsi3"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi3pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi3sk"
      key_type       = "RANGE"
    }
  }

  # OTT rows carry a `ttl` epoch-seconds attribute; sweeps happen server-side.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "objects" {
  bucket = "${local.prefix}-objects-${local.suffix}"

  lifecycle {
    prevent_destroy = true
  }
}

/**
 * Versioning turns every delete into a delete marker, so the object sweep (D6),
 * a leaked token, or a client-side mass-delete all become recoverable for the
 * window set by expire-noncurrent-versions below. Deliberately needs NO IAM
 * change: the execution role holds s3:DeleteObject, which on a versioned bucket
 * writes a marker rather than destroying a version, so the API physically
 * cannot hard-delete a photo. Only the lifecycle rule reclaims bytes.
 */
resource "aws_s3_bucket_versioning" "objects" {
  bucket = aws_s3_bucket.objects.id

  versioning_configuration {
    status = "Enabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "objects" {
  bucket                  = aws_s3_bucket.objects.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

/**
 * Web clients PUT directly to presigned URLs from the browser; ente's own
 * self-hosting docs list the headers. ETag must be exposed for multipart.
 */
resource "aws_s3_bucket_cors_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id

  cors_rule {
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id

  # Originals only (tag applied by the API at commit). GLACIER_IR — never
  # Deep Archive (guard-tested in test/infra).
  rule {
    id     = "originals-to-glacier-ir"
    status = "Enabled"

    filter {
      tag {
        key   = "tier"
        value = "original"
      }
    }

    transition {
      days          = 0
      storage_class = "GLACIER_IR"
    }
  }

  # Abandoned multipart uploads (clients on flaky links) are swept.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  /**
   * The recovery window for the versioning above, and the price of it: deleted
   * and overwritten bytes keep billing until this fires. 30 days is chosen to
   * mirror museum's trash retention, so a photo is recoverable for ~30 days in
   * the trash and ~30 more after the sweep hard-deletes it.
   *
   * Cost note: a noncurrent version of an ORIGINAL is already in GLACIER_IR,
   * which bills a 90-day minimum, so expiring it at 30 days incurs a prorated
   * early-deletion charge for the remaining ~60 (about $0.008/GB at GIR
   * prices). That is the deliberate trade — cheap insurance on irreplaceable
   * data. Raise this to 90 to avoid the penalty entirely, at the cost of
   * holding deleted bytes three times as long.
   *
   * Delete markers are left to accumulate: they carry no storage charge, and
   * expired_object_delete_marker alongside a filter is a known source of
   * perpetual diffs.
   */
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}
