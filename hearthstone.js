const fs = require('original-fs');
const path = require('path');
const ini = require('ini');
const request = require('request');
const async = require('async');
const config = require(path.join(__dirname, 'config.json'));
const app = require('electron').app;

const Store = require(path.join(__dirname, 'Store.js'));
let store = new Store({ configName: 'user' });

let busyFlag = false;

const packStorage = require('electron-json-storage');
const lineStorage = require('electron-json-storage');

module.exports = {
  configFile: process.platform === 'win32' ? require('os').homedir() + '\\AppData\\Local\\Blizzard\\Hearthstone\\log.config' : require('os').homedir() + '/Library/Preferences/Blizzard/Hearthstone/log.config',

  logPath: process.platform === 'win32' ? 'C:\\Program Files (x86)\\Hearthstone\\Logs\\' : '/Applications/Hearthstone/Logs/',

  region: 'xx',

  requiredLogs: [
    'Achievements',
    'BattleNet',
  ],

  setup: function() {
    let self = this;
    fs.readFile(this.configFile, 'utf8', function(error, contents) {
      if (error) {
        contents = '';
      }

      let existing = ini.parse(contents);

      self.requiredLogs.forEach(function(v) {
        if (typeof existing[v] === 'undefined') {
          existing[v] = {};
        }

        existing[v].LogLevel = 1;
        existing[v].FilePrinting = true;
      });

      fs.writeFile(self.configFile, ini.stringify(existing), function(){});
    });
  },

  getRegion: function(callback) {
    let self = this;

    return fs.readFile(path.join(this.logPath, 'BattleNet.log'), 'utf8', function(error, contents) {
      if (error) return;

      let line = contents.substr(0, 128);

      let region = line.match(/(us|eu|kr)\.actual.battle.net/);

      let new_region = (region === null) ? store.get('region') : region[1];

      if (self.region !== new_region) {
        self.region = new_region;

        store.set('region', self.region);

        app.emit('status-change', 'Updated region to ' + new_region.toUpperCase());

        setTimeout(function(){
          app.emit('status-change', 'Watching for packs...');
        }, 5000);

      }
      callback();
    });
  },

  buildRequest: function(pack) {
    return {
      url: 'https://staging.pitytracker.com/api/v1/packs',
      body: pack,
      json: true,
      headers: {
        pobtoken: store.get('token'),
        Authorization: 'Token token="'+ config.apptoken +'"',
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  },

  sendPack: function(pack, self){
    if (busyFlag) {return false}
    busyFlag = true;
    let asyncOptions = {
      times: 6,
      interval: function(retryCount) {
        return 500 * Math.pow(2, retryCount); // 1s, 2s, 4s, 8s, etc
      }
    }

    asyncTask = function (callback, results) {
      app.emit('status-change', 'Uploading your pack to PityTracker...');
      req = self.buildRequest(pack);
      return request.post(req, function(error, response, body){
        if (response && response.statusCode < 300) {
          app.emit('status-change', 'Pack uploaded to PityTracker.');
          busyFlag = false;
          let unsentPacks = store.get('unsentPacks')
          delete unsentPacks[pack.created_at_hs]
          store.set('unsentPacks',unsentPacks)
          self.clearPendingFlags()
          setTimeout(function(){
            app.emit('status-change', 'Watching for packs...');
          }, 5000);
          callback(null, 'done');
        }
        else {
          app.emit('status-change', 'Retrying pack upload...');
          callback('failed', null);
        }
      });
    }

    asyncCallback = function(err, result) {
      if (err) {
        let message = 'Failed: Pack couldn\'t be uploaded to PityTracker.';
        app.emit('status-change', message);
        busyFlag = false;
        pack.pending = false;
        unsentPacks = store.get('unsentPacks') == '' ? {} : store.get('unsentPacks')
        unsentPacks[pack.created_at_hs] = pack
        store.set('unsentPacks', unsentPacks)

        setTimeout(function(){
          app.emit('status-change', 'Watching for packs...');
        }, 5000);
      }
    }

    async.retry(asyncOptions, asyncTask, asyncCallback);
  },

  storePack: function(pack) {
    unsentPacks = store.get('unsentPacks') == '' ? {} : store.get('unsentPacks')
    unsentPacks[pack.created_at_hs] = pack
    store.set('unsentPacks', unsentPacks)
  },

  getLines: function() {
    let logFile = path.join(this.logPath, 'Achievements.log');
    fs.watchFile(logFile, { interval: 1007 }, function(current, old){
      fs.readFile(logFile, 'utf8', function(error, contents){
        if (contents) {
          let newLines = contents.substr(old.size, current.size - old.size);
          let matches = [];
          newLines.replace(/(D .+?NotifyOfCardGained.+? \d+)/g, function(all, rawCardLine){
            matches.push(all);
          });
          packStorage.set('lines', matches, function(error) {
            if (error) throw error;
          });
        }
      });
    });
  },

  clearPendingFlags: function() {
    unsentPacks = store.get('unsentPacks')
    if (Object.keys(unsentPacks).length > 0) {
      console.log('clearPendingFlags found packs: ',unsentPacks);
      Object.values(unsentPacks).forEach(function(pack) {
        pack.pending = false;
      });
      store.set('unsentPacks',unsentPacks)
    }

  },

  watchPacks: function() {
    let self = this;
    fs.watchFile(store.path, { interval: 1007 }, function(current, old){
      if (current.size != old.size) {
        unsentPacks = store.get('unsentPacks')
        let packsToSend = Object.values(unsentPacks).filter( ( pack ) => {
          return pack.pending == false
        });

        Object.values(unsentPacks).forEach(function(pack) {
          pack.pending = true
        });
        store.set('unsentPacks',unsentPacks)

        if (Object.keys(packsToSend).length > 0) {
          Object.values(packsToSend).forEach(function(element) {
            self.sendPack(element, self);
          });
        }
      }

    });
  },

  watchLogfile: function() {
    let self = this;
    let logFile = path.join(this.logPath, 'Achievements.log');
    fs.watchFile(logFile, function(current, old){
      fs.readFile(logFile, 'utf8', function(error, contents){
        if (contents) {
          let data = contents.substr(old.size, current.size - old.size);
          let matches = [];
          let now = new Date()
          data.replace(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\d+ NotifyOfCardGained: \[name=.+? cardId=(.+?) type=.+?\] (GOLDEN|NORMAL) (\d)/g, function(all,h,m,s,ms, cardId, golden, owned){
            matches.push({
              cardId: cardId,
              golden: golden === 'GOLDEN',
              owned: +owned,
              time: new Date(now.getFullYear(),now.getMonth(),now.getDate(),+h,+m,+s,+ms)
            });
          });

          if (matches.length >= 5 && matches.length % 5 === 0) {
            self.getRegion(function(){
              app.emit('status-change', 'Pack found!');

              let n = 5;
              let chunks = Array(Math.ceil(matches.length/n)).fill().map((_,i) => matches.slice(i*n,i*n+n));;
              chunks.forEach(function(element) {
                let pack = {
                  created_at_hs: element[0].time.toString(),
                  region: self.region,
                  cards: element,
                  pending: false
                }
                self.storePack(pack);
              });
            });
          } else {
            console.log('Raise NotImplementedError: Half-Pack Problem')
          }
        }
      })
    });
  }
};
