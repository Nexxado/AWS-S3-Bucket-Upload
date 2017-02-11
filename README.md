# S3 Bucket Upload script

* Script to automatically upload files to S3 Bucket
* Written in NodeJS using AWS SDK

## Table of contents
* [Example Use Cases](#example-use-cases)
* [Prerequisites](#prerequisites)
* [Usage](#usage)
* [Files](#files)
* [Script Options](#script-options)
* [Script Algorithm](#script-algorithm)
* [AWS User Policy](#aws-user-policy)
* [Config Example](#config-example)
* [S3 Bucket CORS Config](#s3-bucket-cors-config)

---

## Example Use Cases
* Automatically update CDN with latest production files
* Upload CI artifacts to S3 bucket.

## Prerequisites
* Run `npm install` to install all dependencies

## Usage
* `node upload.js <bucket name> <path to distribution files> [args]`
* Can optionally set environment variables and pass command line arguments, see [Script Options](#script-options).
* For help specify `--help` option, for example: `node upload.js --help`

## Files
* `upload.js` - script file
* `AwsConfig.json` - AWS Credential config 

## Script Options
* Environment Variables
    * `BUCKET_NAME` - Required (if not passed as argument), name of S3 bucket to upload files to.
    * `DIST_PATH` - Required (if not passed as argument) , path to the distribution file(s).
* Command Line Options
    * `--folder <folder>` - name of the folder to put the files in, default is bucket root: `''`.
    * `--acl <acl>` - ACL for the uploaded files, default: `private`, options: `private | public-read | public-read-write | authenticated-read | aws-exec-read | bucket-owner-read | bucket-owner-full-control`
    * `--empty` - specify if bucket should be emptied before upload, default: `false`.
    * `--config path/to/config` - used to overwrite path to default config file: `./AwsConfig.json`.
    * `--datestamp` - Add current date to the bucket folder, format: yyyyMMdd, default: `true`.

## Script Algorithm
1. init `AWS-SDK`, loading credentials from `AwsConfig` file.
2. If `--empty` option specified, Empty current contents of `BUCKET_FOLDER`
3. Once done emptying `BUCKET_FOLDER`, start deployment of distribution files
4. Read `DIST_PATH` directory recursively - reading all files in all sub-directories
5. Upload all read files
6. Once done, print deployment stats - how many files uploaded successfully\failed. 

## AWS User Policy
Required user policy to access and modify destination bucket  
User's `accessKeyId` and `secretAccessKey` must be written into `AwsConfig.json`.

1. Goto AWS IAM -> Policies -> Create Policy -> Policy Generator
1. Add first statement
    1. Choose AWS Service: `AWS S3`
    1. Actions: `ListBucket`
    1. ARN: `arn:aws:s3:::BUCKET_NAME`
    1. Click `Add Statement`
1. Add second statement
    1. Choose AWS Service: `AWS S3`
    1. Actions: `DeleteObject`, `GetObject`, `PutObject`, `PutObjectAcl`
    1. ARN: `arn:aws:s3:::BUCKET_NAME/*`
    1. Click `Add Statement`
1. Click `Next Step`
1. Add Policy name and description
1. Click `Validate Policy` to make sure the policy is valid.
1. Click `Create Policy`
1. Attach policy to AWS user

Notice how bucket level actions gets its own separate statement with the bucket itself (`BUCKET_NAME`) as the resource  
and object level actions gets their own statement with the bucket content (`BUCKET_NAME/*`) as the resource

* All uploaded files must have permissions to `open/download` for `Everyone`

### Example Policy:
``` json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::BUCKET_NAME"
            ]
        },
        {
            "Sid": "Stmt1481201463000",
            "Effect": "Allow",
            "Action": [
                "s3:DeleteObject",
                "s3:GetObject",
                "s3:PutObject",
                "s3:PutObjectAcl"
            ],
            "Resource": [
                "arn:aws:s3:::BUCKET_NAME/*"
            ]
        }
    ]
}
```

## Config Example
``` json
{
  "accessKeyId": "XXXXXXXXXXXXXXXXXXXXXX",
  "secretAccessKey": "YYYYYYYYYYYYYYYYYYYYYYYYYYYY"
}
```

## S3 Bucket CORS Config
If bucket is used as CDN, the browser will block some files that are served Cross Origin.
Add the following CORS configuration to the S3 Bucket:
``` xml
<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <CORSRule>
        <AllowedOrigin>*</AllowedOrigin>
        <AllowedMethod>GET</AllowedMethod>
        <AllowedHeader>*</AllowedHeader>
    </CORSRule>
</CORSConfiguration>
```