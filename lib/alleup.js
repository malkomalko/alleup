var formidable = require('formidable')
  , util = require('util')
  , im = require('imagemagick')
  , fs = require('fs')
  , path = require('path')
  , hat = require('hat')
  , rack = hat.rack()
  , knox = require('knox')
  , async = require('async');

var config_file = './alleup.json'
  , s3client = undefined
  , uploaddir = undefined
  , storage_type = undefined;

var Alleup = exports = module.exports = function Alleup(options) {
  config_file = (typeof options['config_file'] === 'undefined')
    ? config_file : options['config_file'];
  storage_type = options['storage'];

  this.config = this.loadConfig(config_file);

  var storageCheck = this.config['storage']['aws'] || this.config['storage']['dir'];

  if (typeof storageCheck == 'undefined') {
    throw new TypeError('No storage defined in alleup config');
  }

  for (storage in this.config['storage']) {
    this[storage + 'Setup'](this.config['storage'][storage]);
  }
};

Alleup.prototype = {

  url: function(file, version) {
    if (!file) return new Error("File is undefined");
    var _file = this.genFileName(file, version);
    return this[storage_type + 'Url'](_file);
  },

  dirUrl: function(file) {
    return uploaddir + file;
  },

  awsUrl: function(file) {
    return s3client.url(file);
  },

  genFileName: function(file, version) {
    var prefix = '/' + file.substr(0,4) + '/';
    return prefix + version + '_' + file;
  },

  remove: function(file, callback) {
    if (!file) return callback(new Error("File is undefined"));

    var self = this
      , deletions = []
      , _resize = Object.keys(self.config['variants']['resize'])
      , _crop = Object.keys(self.config['variants']['crop']);

    _resize.forEach(function(version) {
      deletions.push(function(next) {
        var fileName = self.genFileName(file, version);
        self[storage_type + 'Remove'](fileName, next);
      });
    });

    _crop.forEach(function(version) {
      deletions.push(function(next) {
        var fileName = self.genFileName(file, version);
        self[storage_type + 'Remove'](fileName, next);
      });
    });

    async.parallel(deletions, function(err, results) {
      callback(err);
    });
  },

  awsRemove: function(file, callback) {
    s3client.deleteFile(file, function(err, res) {
      callback(err);
    });
  },

  dirRemove: function(file, callback) {
    fs.unlink(uploaddir + file, function(err) {
      callback(err);
    });
  },

  upload: function(req, res, callback) {
    this.makeVariants(req.files.file, function(err, file) {
      callback(err, file, res);
    });
  },

  awsSetup: function(options) {
    s3client = knox.createClient({
        key: options['key']
      , secret: options['secret']
      , bucket: options['bucket']
    });
  },

  dirSetup: function(options) {
    uploaddir = options['path'];
  },

  makeVariants: function(file, callback) {
    var self = this
      , _resize = self.config['variants']['resize']
      , _crop = self.config['variants']['crop']
      , new_file = rack()
      , ext = '.jpg';
    new_file += ext;

    var i = 0;
    for(prefix in _resize) {
      var fileName = this.genFileName(new_file, prefix);
      this.imAction(
        'im.resize', file, fileName, _resize[prefix],
      function(err) {
        i++;
        if (i == Object.keys(self.config.variants.resize).length) {
          i = 0;
          for(prefix in _crop) {
            var fileName = self.genFileName(new_file, prefix);
            self.imAction(
              'im.crop', file, fileName, _crop[prefix],
            function(err) {
              i++;
              if (i == Object.keys(self.config.variants.crop).length) {
                fs.unlink(file['path']);
                callback(err, new_file);
              } else {
                callback(err, new_file);
              }
            });
          };
        };
      });
    };
  },

  pushToS3: function(sfile, dfile, content_type, callback) {
    fs.readFile(sfile, function(err, buf) {
      if (err) return callback(err);

      var req = s3client.put(dfile, {
          'Content-Length': buf.length
        , 'Content-Type': content_type
      });

      req.on('response', function(res) {
        if (200 == res.statusCode) {
          fs.unlink(sfile);
          callback(err);
        } else {
          callback(err);
        }
      });

      req.end(buf);
    });
  },

  loadConfig: function(resource) {
    if (fs.existsSync(resource)) {
      try {
        return JSON.parse(fs.readFileSync(resource));
      } catch (err) {
        var msg = 'Could not parse JSON config at ' + path.resolve(resource);
        throw new Error(msg);
      }
    }

    throw new Error('Could not read JSON config at ' + resource + '.');
  },

  imAction: function(action, file, prefix, size, callback) {
    var self = this
      , dfile = prefix
      , tfile = (storage_type === 'dir')
          ?  uploaddir + prefix
          : file['path'] + prefix.replace(/\//g,'')
      , imOptions = this.imOptions(file, tfile, size);

    eval(action)(imOptions, function(err, stdout, stderr) {
      if (storage_type === 'aws') {
        self.pushToS3(tfile, dfile, file['type'], function(err) {
          callback(err);
        });
      } else {
        callback(err);
      }
    });
  },

  setExtension: function(content_type) {
    switch(content_type) {
      case 'image/jpeg':
        var ext = '.jpg'
        break;
      case 'image/png':
        var ext = '.png'
        break;
      case 'image/gif':
        var ext = '.gif'
        break;
    };

    return ext;
  },

  imOptions: function(file, tfile, size) {
    var _size = size.split('x');
    return {
      srcPath: file['path'],
      dstPath: tfile,
      width: _size[0] + '^',
      height: _size[1],
      quality: 0.7,
      customArgs: [
        "-gravity", "center",
        "-extent", size
      ]
    };
  }
};
