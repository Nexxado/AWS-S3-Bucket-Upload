var fs = require('fs');
var AWS = require('aws-sdk');
var yargs = require('yargs')
    .usage('node $0 <bucket name> <path/to/distribution_files> [args]')
    .options({
        empty: {
            default: false,
            describe: 'Empty the specified S3 Bucket folder',
            type: 'boolean'
        },
        folder: {
            default: '',
            describe: 'Specify S3 bucket folder as upload destination',
            type: 'string',
            alias: ['dir', 'directory']
        },
        config: {
            default: './AwsConfig.json',
            describe: 'Path to AWS Config json file that includes accessKeyId & secretAccessKey',
            type: 'string',
            alias: 'cfg',
            requiresArg: true
        },
        acl: {
            default: 'private',
            describe: 'Access permissions for the uploaded file(s)',
            type: 'string',
            alias: 'access',
            choices: ['private', 'public-read', 'public-read-write', 'authenticated-read', 'aws-exec-read', 'bucket-owner-read', 'bucket-owner-full-control'],
            requiresArg: true
        },
        datestamp: {
            default: true,
            describe: 'Add current date to the bucket folder, format: yyyyMMdd',
            type: 'boolean',
            alias: 'date'
        }
    })
    .version()
    .help()
    .argv;


// Make sure required environment variables are set or passed as arguments.
if ((!process.env.BUCKET_NAME && !yargs._[0]) || (!process.env.DIST_PATH && !yargs._[1])) {
    console.log('Required parameters not set, please set BUCKET_NAME and DIST_PATH environment variables');
    console.log('Or pass them as arguments: \'node upload.js <bucket name> <path to distribution files>\"');
    console.log('Exiting...');
    process.exit(-1);
}

// Script Options
var BUCKET_NAME = yargs._[0] || process.env.BUCKET_NAME;
var DIST_PATH = yargs._[1] || process.env.DIST_PATH;
var BUCKET_ACL = yargs.acl;
var BUCKET_FOLDER = yargs.folder;
var AWS_CONFIG = yargs.config;
var shouldEmptyBucket = yargs.empty;
var shouldStampBucketFolder = yargs.datestamp;

// Minimum size in MB that will invoke a multiPartUpload instead of regular file upload.
var MULTI_PART_SIZE = 5;

// Statistics Variables
var numOfFiles = 0;
var numOfUploaded = 0;
var numOfFilesProcessed = 0;

// Initialize AWS SDK
AWS.config.loadFromPath(AWS_CONFIG);
var s3 = new AWS.S3({
    httpOptions: {
        timeout: 300000 // 5 minutes in ms
    }
});

// Update BUCKET_FOLDER according to datestamp option.
if (shouldStampBucketFolder && BUCKET_FOLDER !== '')
    BUCKET_FOLDER += generateDatestamp();

// If path to distribution files is a directory and doesn't end with '/', add a '/'.
if (DIST_PATH.slice(-1) !== '/' && fs.lstatSync(DIST_PATH).isDirectory())
    DIST_PATH += '/';

printScriptOptions();
deploy();

/**
 * Deploy production files
 * 1. Empty bucket
 * 2. Once bucket is empty, upload files.
 */
function deploy() {
    console.log(generateTimestamp(), 'Starting deploy process. - bucket: ' + BUCKET_NAME);
    if (shouldEmptyBucket)
        emptyBucketFolder(uploadProductionFiles);
    else
        uploadProductionFiles();
}

/**
 * Print deploy stats
 */
function printStats() {
    console.log('#Files: ' + numOfFiles + ', #Uploaded: ' + numOfUploaded + ', #Errors: ' + (numOfFiles - numOfUploaded));

    console.log(generateTimestamp(), 'Finished uploading production files.');

    if (numOfUploaded < numOfFiles)
        process.exit(-1);
}

/**
 * Upload production files to bucket
 */
function uploadProductionFiles() {
    console.log(generateTimestamp(), 'Starting to upload production files.');
    var isDirectory = fs.lstatSync(DIST_PATH).isDirectory();

    if (isDirectory)
        uploadMultiple(BUCKET_FOLDER, printStats);
    else {
        numOfFiles = 1;
        var remotePath = BUCKET_FOLDER === '' ? '' : BUCKET_FOLDER + '/';
        remotePath += DIST_PATH.substring(DIST_PATH.lastIndexOf('/') + 1); //Exract file name from path
        uploadFile(remotePath, DIST_PATH, printStats);
    }

}

/**
 * Empty Bucket folder contents, if folder is '' it'll empty the entire bucket.
 * @param callback {Function} - function to execute once successfully emptied bucket
 */
function emptyBucketFolder(callback) {
    console.log(generateTimestamp(), 'Emptying bucket.');
    var params = {
        Bucket: BUCKET_NAME
    };
    s3.listObjects(params, function (err, data) {
        if (err)
            return console.log(err, err.stack); // an error occurred

        if (!data.Contents || !data.Contents.length)
            return callback();

        if (BUCKET_FOLDER !== '') //If bucket folder was specified, filter out all objects outside of folder
            data.Contents = data.Contents.filter(function (object) {
                return object.key.indexOf(BUCKET_FOLDER) >= 0;
            });

        deleteMultipleObjects(data.Contents.map(function (object) {
            return { Key: object.Key };
        }), callback);
    });
}

/**
 * Delete multiple objects from bucket
 * @param objects {Array} - array of objects with "Key" properties defining which objects to delete
 * @param callback {Function} - function to execute once successfully deleted objects
 */
function deleteMultipleObjects(objects, callback) {
    var params = {
        Bucket: BUCKET_NAME,
        Delete: {
            Objects: objects
        }
    };
    s3.deleteObjects(params, function (err, data) {
        if (err)
            return console.log(err, err.stack); // an error occurred

        callback();
    });
}

/**
 * Upload multiple files to bucket
 * @param remoteFolderName {String} - folder in bucket to upload files to.
 * @param callback {Function} - function to execute once all files have been processed.
 */
function uploadMultiple(remoteFolderName, callback) {
    var fileList = getFileListRecursively(DIST_PATH, '');

    if (remoteFolderName !== '' && remoteFolderName.slice(-1) !== '/')
        remoteFolderName += '/';


    fileList.forEach(function (entry) {
        numOfFiles++;

        uploadFile(remoteFolderName + entry,
            DIST_PATH + entry,
            callback);
    });
}

/**
 * Upload file to bucket
 * @param remoteFilename {String} - key (in the S3 bucket) for the uploaded file
 * @param fileName {String} - name of file to upload.
 * @param callback {Function} - function to execute once all files have been processed.
 */
function uploadFile(remoteFilename, fileName, callback) {
    var fileSize = Math.ceil(fs.statSync(fileName)['size'] / 1024 / 1024); //Get file size in MB

    //If file size is too big, upload it in parts
    if (fileSize >= MULTI_PART_SIZE) {
        multiPartUpload(Math.ceil(fileSize / MULTI_PART_SIZE), remoteFilename, fileName, callback);
        return;
    }

    var fileBuffer = fs.readFileSync(fileName);
    var metaData = getContentTypeByFile(fileName);

    var request = s3.putObject({
        ACL: BUCKET_ACL,
        Bucket: BUCKET_NAME,
        Key: remoteFilename,
        Body: fileBuffer,
        ContentType: metaData
    }, function (error, response) {
        numOfFilesProcessed++;
        process.stdout.write('.'); //Give sense of progress bar

        if (error) {
            console.log('Failed to upload ' + fileName, 'Error: ' + error);
        }
        else {
            numOfUploaded++;
            // console.log('uploaded file[' + fileName + '] to [' + remoteFilename + '] as [' + metaData + ']');
            // console.log(arguments);
        }

        if (numOfFilesProcessed === numOfFiles) {
            process.stdout.write('\n');
            callback();
        }
    });

    // Define progress listener
    request.on('httpUploadProgress', function (progress, response) {
        console.log(generateTimestamp(), '##### File: ' + this.params.Key + ', Uploaded: ' + Math.round((progress.loaded / 1024) / 1024) + ' MB - ' + Math.round((progress.loaded / progress.total) * 100) + ' %');
    });
}

/**
 * Upload file to bucket in several parts - used for large files
 * @param queueSize {Number} - the size of the concurrent queue manager to upload parts in parallel
 * @param remoteFilename {String} - key (in the S3 bucket) for the uploaded file
 * @param fileName {String} - name of file to upload.
 * @param callback {Function} - function to execute once all files have been processed.
 */
function multiPartUpload(queueSize, remoteFilename, fileName, callback) {
    var fileBuffer = fs.readFileSync(fileName);
    var metaData = getContentTypeByFile(fileName);

    var params = {
        ACL: BUCKET_ACL,
        Bucket: BUCKET_NAME,
        Key: remoteFilename,
        Body: fileBuffer,
        ContentType: metaData
    };
    var options = {
        // params: params,
        queueSize: queueSize, // Queue size will be filesize split into chunks of 5 MB
        partSize: 1024 * 1024 * MULTI_PART_SIZE // Each part is 5 MB
    };

    s3.upload(params, options, function (error, data) {
        // console.log('upload.send', err, data);
        numOfFilesProcessed++;

        if (error) {
            console.log('Failed to upload ' + fileName, 'Error: ' + error);
        } else {
            numOfUploaded++;
        }

        if (numOfFilesProcessed === numOfFiles) {
            process.stdout.write('\n');
            callback();
        }
    })
        .on('httpUploadProgress', function (progress, response) {
            console.log(generateTimestamp(), '##### File: ' + this.service.config.params.Key + ', Uploading Part: ' + Math.round((progress.loaded / 1024) / 1024) + ' MB - ' + Math.round((progress.loaded / progress.total) * 100) + ' %');
        });

    // // Create upload object with settings.
    // var upload = new AWS.S3.ManagedUpload(options);
    // 
    // // Define progress listener
    // upload.on('httpUploadProgress', function (progress, response) {
    //     console.log(generateTimestamp(), '##### File: ' + this.service.config.params.Key + ', Uploading Part: ' + Math.round((progress.loaded / 1024) / 1024) + ' MB - ' + Math.round((progress.loaded / progress.total) * 100) + ' %');
    // });
    // 
    // // Initiate Upload.
    // upload.send(function (error, data) {
    // // console.log('upload.send', err, data);
    // numOfFilesProcessed++;
    // 
    // if (error) {
    //     console.log('Failed to upload ' + fileName, 'Error: ' + error);
    // } else {
    //     numOfUploaded++;
    // }
    // 
    // if (numOfFilesProcessed === numOfFiles) {
    //     process.stdout.write('\n');
    //     callback();
    // }
    // });
}

/**
 * Get file list from local directory
 * @param path {String} - path to local directory where the files are located
 * @returns {Array} - list of files
 */
function getFileList(path) {
    var i, fileInfo, filesFound;
    var fileList = [];

    filesFound = fs.readdirSync(path);
    for (i = 0; i < filesFound.length; i++) {
        fileInfo = fs.lstatSync(path + filesFound[i]);
        if (fileInfo.isFile()) fileList.push(filesFound[i]);
    }
    return fileList;
}

/**
 * Get file list from local directory and all its sub-directories
 * @param path {String} - path to directory where the files are located
 * @param sub_dir {String} - sub directory name
 * @returns {Array} - list of files
 */
function getFileListRecursively(path, sub_dir) {
    var i, fileInfo, filesFound;
    var fileList = [];

    filesFound = fs.readdirSync(path);
    for (i = 0; i < filesFound.length; i++) {
        fileInfo = fs.lstatSync(path + filesFound[i]);
        if (fileInfo.isFile())
            fileList.push(sub_dir + filesFound[i]);
        else if (fileInfo.isDirectory())
            fileList.push.apply(fileList, getFileListRecursively(path + filesFound[i] + '/', sub_dir + filesFound[i] + '/'));
    }
    return fileList;
}

/**
 * Get content type according to file nam
 * @param fileName {String} - name of file
 * @returns {string} - content type
 */
function getContentTypeByFile(fileName) {
    var rc = 'application/octet-stream';
    var fn = fileName.toLowerCase();

    if (fn.indexOf('.html') >= 0) rc = 'text/html';
    else if (fn.indexOf('.css') >= 0) rc = 'text/css';
    else if (fn.indexOf('.json') >= 0) rc = 'application/json';
    else if (fn.indexOf('.js') >= 0) rc = 'application/x-javascript';
    else if (fn.indexOf('.png') >= 0) rc = 'image/png';
    else if (fn.indexOf('.jpg') >= 0) rc = 'image/jpg';
    else if (fn.indexOf('.svg') >= 0) rc = 'image/svg+xml';

    return rc;
}

/**
 * Generate timestamp according to current time.
 * @returns {String} - timestamp in format of HH:mm:ss
 */
function generateTimestamp() {
    // toTimeString() is in format: '10:30:06 GMT+0200 (Jerusalem Standard Time)'
    // Split with ' ' and we get: ['10:30:06', 'GMT+0200', '(Jerusalem', 'Standard', 'Time)']
    // Take the first value from array as timestamp
    return new Date().toTimeString().split(' ')[0];
}

/**
 * Generate date stamp according to today's date.
 * @return {String} - date stamp in format of yyyyMMdd
 */
function generateDatestamp() {
    var date = new Date();

    var year = date.getFullYear();
    var month = date.getMonth() + 1;
    var day = date.getDate();

    if (month < 10)
        month = '0' + month;

    if (day < 10)
        day = '0' + day;

    return '.' + year + month + day;
}

/**
 * Print the script's options that will be used when running
 */
function printScriptOptions() {
    console.log('\nRunning S3 Bucket Upload script');
    console.log('\n*** Options ***');
    console.log('BUCKET_NAME (required) = ', BUCKET_NAME);
    console.log('DIST_PATH (required) =', DIST_PATH);
    console.log('AWS_CONFIG =', AWS_CONFIG);
    console.log('EMPTY_BUCKET =', shouldEmptyBucket);
    console.log('BUCKET_FOLDER =', BUCKET_FOLDER);
    console.log('BUCKET_ACL =', BUCKET_ACL);
    console.log('DATESTAMP_FOLDER = ', shouldStampBucketFolder);
}