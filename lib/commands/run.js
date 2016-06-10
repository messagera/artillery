/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const _ = require('lodash');
const core = require('artillery-core');
const runner = core.runner;
const fs = require('fs');
const path = require('path');
const async = require('async');
const csv = require('csv-parse');
const util = require('util');
const cli = require('cli');
const YAML = require('yamljs');
const defaultOptions = require('rc')('artillery');
const moment = require('moment');
const chalk = require('chalk');
const express = require('express');
const request = require('request');
const bodyParser = require('body-parser');
const stats = require("stats-lite");


let timestamps = [];
let assistants = {};
let userIds = {};

module.exports = run;

function run(scriptPath, options) {
 
  var app = express();

  app.use(bodyParser.json());

  app.post('/receiveMessage', function(req, res){

    var receivingUser = req.body.to.id;
    var assistantId = req.body.from;

    //assistants[assistantId].responses = assistants[req.body.from].responses + 1 || 1;
    //assistants[req.body.from].receivedMessages.push();
    userIds[receivingUser].responses = userIds[req.body.to.id].responses + 1 || 1;
    
    if (!userIds[receivingUser].receivedMessages){
      userIds[receivingUser].receivedMessages = [];  
    }
    if (!assistants[assistantId].incorrectResponseLog ){
      assistants[assistantId].incorrectResponseLog = [];
    }

    userIds[receivingUser].receivedMessages.push(req.body.message);
    
    var sequenceOrdinalNumber = userIds[receivingUser].receivedMessages.length - 1;

    var testParameters = [];

    testParameters[0] = 'Ok, what day works best?';
    testParameters[1] = 'Ok, with whom would you like to schedule?';
    testParameters[2] = 'Ok, would you prefer morning, afternoon, or evening?';
    testParameters[3] = 'Ok, what\'s your name';
    testParameters[4] = 'Got it, Mary. Let me see if we can do this.';

    var lastMessage = userIds[receivingUser].receivedMessages[sequenceOrdinalNumber]
    var expectedString = testParameters[sequenceOrdinalNumber]

    if ( ! lastMessage.includes(expectedString)){
      console.log(`incorrect | msgNumber ${sequenceOrdinalNumber+1} , userId ${receivingUser}, assistantId ${assistantId} : '${lastMessage}' does not contain '${expectedString}'`);
      
      assistants[assistantId].incorrectResponseLog.push(`msgNumber ${sequenceOrdinalNumber+1} , userId ${receivingUser}, assistantId ${assistantId} : '${lastMessage}' does not contain '${expectedString}'`)
      assistants[assistantId].incorrectResponses = assistants[req.body.from].incorrectResponses + 1 || 1;
    } else {
     // console.log(`correct | msgNumber ${sequenceOrdinalNumber+1} , userId ${receivingUser}, assistantId ${assistantId} : '${lastMessage}' contains '${expectedString}'`);
      assistants[assistantId].correctResponses = assistants[req.body.from].correctResponses + 1 || 1;
    }

    timestamps.push(req.body.timestamps);

    res.status(200).send();
  })

function checkMessage(userId){
  if (userIds[userId] !== correctResponse){
    //log Error
  }

}

  app.listen(4000);

  let logfile;
  if (options.output) {
    logfile = options.output;
    if (!logfile.match(/\.json$/)) {
      logfile += '.json';
    }
  } else {
    if (defaultOptions.output) {
      logfile = moment().format(defaultOptions.output);
    } else {
      logfile = moment().format('[artillery_report_]YMMDD_HHmmSS[.json]');
    }
  }

  function log() {
    if (options.quiet) { return; }
    console.log.apply(console, arguments);
  }

  async.waterfall([
    function readScript(callback) {

      fs.readFile(scriptPath, 'utf-8', function(err, data) {

        if (err) {
          const msg = util.format('File not found: %s', scriptPath);
          return callback(new Error(msg), null);
        }

        let script;
        let fileformat;
        try {
          if (/\.ya?ml$/.test(path.extname(scriptPath))) {
            fileformat = 'YAML';
            script = YAML.parse(data);
          } else {
            fileformat = 'JSON';
            script = JSON.parse(data);
          }
        } catch (e) {
          const msg2 = `File ${scriptPath} does not appear to be valid ${fileformat}: (${e.message})`;
          return callback(new Error(msg2), null);
        }

        if (options.target && script.config) {
          script.config.target = options.target;
        }

        if (!script.config.target && !options.environment) {
          const msg4 = 'No target specified and no environment chosen';
          return callback(new Error(msg4), null);
        }

        let validation = core.validate(script);
        if (!validation.valid) {
          log(validation.errors);
          return callback(new Error('Test script validation error'), null);
        }

        return callback(null, {script: script});
      });
    },
    function readPayload(context, callback) {

      if (context.script.config.payload && _.isArray(context.script.config.payload)) {
        async.map(context.script.config.payload,
          function(item, callback2) {
            let absoluteScriptPath = path.resolve(process.cwd(), scriptPath);
            let payloadFile = path.resolve(path.dirname(absoluteScriptPath), item.path);

            let data = fs.readFileSync(payloadFile, 'utf-8');
            csv(data, function(err, parsedData) {
              item.data = parsedData;
              return callback2(err, item);
            });
          },
          function(err, results) {
            if (err) {
              return callback(err, null);
            }
            context.payload = results;
            return callback(null, context);
          });
      } else if (context.script.config.payload &&
                 _.isObject(context.script.config.payload) &&
                 options.payload) {
        let csvdata = fs.readFileSync(options.payload, 'utf-8');
        csv(csvdata, function(err, payload) {

          if (err) {
            const msg3 = util.format(
              'File %s does not appear to be valid CSV', options.payload);
            return callback(new Error(msg3), null);
          }

          context.payload = payload;

          return callback(null, context);
        });
      } else {
        if (context.script.config.payload) {
          log(
            'WARNING: payload file not set, but payload is configured in %s\n',
            scriptPath);
        }

        return callback(null, context);
      }
    },
    function checkIfXPathIsUsed(context, callback) {
      // FIXME: This should probably be in core.
      let xmlInstalled = null;
      try {
        xmlInstalled = require('artillery-xml-capture');
      } catch (e) {
      }

      let usesXPathCapture = false;
      context.script.scenarios.forEach(function(scenario) {
        scenario.flow.forEach(function(step) {
          let params  = step[_.keys(step)[0]];
          if ((params.capture && params.capture.xpath) ||
              (params.match && params.match.xpath)) {
            usesXPathCapture = true;
          }
        });
      });
      if (usesXPathCapture && !xmlInstalled) {
        console.log(chalk.bold.red('Warning: '), chalk.bold.yellow('your test script is using XPath capture, but artillery-xml-capture does not seem to be installed.'));
        console.log(chalk.bold.yellow('Install it with: npm install -g artillery-xml-capture'));
      }
      return callback(null, context);
    }
    ],
    function(err, result) {

      if (err) {
        log(err.message);
        process.exit(1);
      }

      if (result.script.config.processor) {
        let absoluteScriptPath = path.resolve(process.cwd(), scriptPath);
        let processorPath = path.resolve(path.dirname(absoluteScriptPath), result.script.config.processor);
        let processor = require(processorPath);
        result.script.config.processor = processor;
      }

      if (options.insecure) {
        if (result.script.config.tls) {
          if (result.script.config.tls.rejectUnauthorized) {
            log('WARNING: TLS certificate validation enabled in the ' +
                        'test script, but explicitly disabled with ' +
                        '-k/--insecure.');
          }
          result.script.config.tls.rejectUnauthorized = false;
        } else {
          result.script.config.tls = {rejectUnauthorized: false};
        }
      }

      for (var payloadIndex in result.payload){
        var payloadContents = result.payload[payloadIndex];
        //console.log(payloadContents.fields[0], "ASdf")
        if (payloadContents.fields[0] === 'assistants'){
          //convert array to object
          assistants = payloadContents.data.reduce(function(object, value, index) {
                          object[value] = {};
                          return object;
                        }, {});
        }
        else if (payloadContents.fields[0] === 'userIds'){
          userIds = payloadContents.data.reduce(function(object, value, index) {
                          object[value] = {};
                          return object;
                        }, {});
        }
      }

      var ee = runner(result.script, result.payload, {
        environment: options.environment
      });

      log('Log file: %s', logfile);

      //var bar;
      //var barTimer;
      ee.on('phaseStarted', function(opts) {
        /*
        log(
          'Phase %s%s started - duration: %ss',
          opts.index,
          (opts.name ? ' (' + opts.name + ')' : ''),
          opts.duration);
      */
        if (!options.quiet && process.stdout.isTTY) {
          cli.spinner('');
        }
        // bar = new ProgressBar('[ :bar ]', {
        //   total: opts.duration,
        //   width: 79
        // });
        // bar.tick();
        // barTimer = setInterval(function() {
        //   bar.tick();
        // }, 1 * 1000);
      });

      ee.on('phaseCompleted', function(opts) {

        //clearInterval(barTimer);
        if (!options.quiet && process.stdout.isTTY) {
          cli.spinner('', true);
        }
       /*
        log(
          'phase %s%s completed',
          opts.index,
          (opts.name ? ' (' + opts.name + ')' : ''));
*/
      });

      ee.on('stats', function(report) {
        if (!options.quiet && process.stdout.isTTY) {
          cli.spinner('', true);
        }

        //log('Intermediate report @ %s', report.timestamp);
        if (!options.quiet) {
          humanize(report);
        }

        if (!options.quiet && process.stdout.isTTY) {
          cli.spinner('');
        }
      });

      ee.once('done', function(report) {
        if (!options.quiet && process.stdout.isTTY) {
          cli.spinner('', true);
        }

        if (process.stdout.isTTY) {
          cli.spinner('', true);
        }

        //log('all scenarios completed');
        log('Complete report @ %s', report.aggregate.timestamp);
        if (!options.quiet) {
          humanize(report.aggregate);
        }

        let processingTimes = [];

        async.each(timestamps,
          function(timestamp, callback){
            processingTimes.push(timestamp.done - timestamp.creation);
            callback();
          },
          function (err){
            if (err){
              console.log(err);
            } else {
              var messageStats = {}
              console.log("sum: %s", stats.sum(processingTimes));
              console.log("mean: %s", stats.mean(processingTimes));
              console.log("median: %s", stats.median(processingTimes));
              console.log("mode: %s", stats.mode(processingTimes));
              console.log("variance: %s", stats.variance(processingTimes));
              console.log("standard deviation: %s", stats.stdev(processingTimes));
              console.log("85th percentile: %s", stats.percentile(processingTimes, 0.85));

              messageStats.sum = stats.sum(processingTimes);
              messageStats.mean = stats.mean(processingTimes);
              messageStats.median = stats.median(processingTimes);
              messageStats.mode = stats.mode(processingTimes);
              messageStats.variance = stats.variance(processingTimes);
              messageStats.stdev = stats.stdev(processingTimes);
              messageStats.percentile = stats.percentile(processingTimes, 0.85);

              fs.writeFile('messageStats.json', `${JSON.stringify(messageStats, null, 2)}\n`, (err) => {
                if (err) throw err;
              });
            }
          }
        );

        fs.writeFile('assistantLog.json', `${JSON.stringify(assistants, null, 2)}\n`, (err) => {
            if (err) throw err;
          });
        fs.writeFile('userLog.json', `${JSON.stringify(userIds, null, 2)}\n`, (err) => {
            if (err) throw err;
          });
        fs.writeFile('timestamps.json', `${JSON.stringify(timestamps, null, 2)}\n`, (err) => {
            if (err) throw err;
          });

        report.phases = _.get(result, 'script.config.phases', []);

        fs.writeFileSync(logfile, JSON.stringify(report, null, 2), {flag: 'w'});

        if (result.script.config.ensure) {
          const latency = report.aggregate.latency;
          _.each(result.script.config.ensure, function(max, k) {

            let bucket = k === 'p50' ? 'median' : k;
            if (latency[bucket]) {
              if (latency[bucket] > max) {
                const msg = util.format(
                  'ensure condition failed: ensure.%s < %s', bucket, max);
                log(msg);
                process.exit(1);
              }
            }
          });
        }
      });

      ee.run();
    });
}

function humanize(report) {
  /*
  console.log('  Scenarios launched: %s', report.scenariosCreated);
  console.log('  Scenarios completed: %s', report.scenariosCompleted);
  console.log('  Number of requests made: %s', report.requestsCompleted);
  console.log('  RPS: %s', report.rps.mean);
  console.log('  Request latency:');
  console.log('    min: %s', report.latency.min);
  console.log('    max: %s', report.latency.max);
  console.log('    median: %s', report.latency.median);
  console.log('    p95: %s', report.latency.p95);
  console.log('    p99: %s', report.latency.p99);
  console.log('  Scenario duration:');
  console.log('    min: %s', report.scenarioDuration.min);
  console.log('    max: %s', report.scenarioDuration.max);
  console.log('    median: %s', report.scenarioDuration.median);
  console.log('    p95: %s', report.scenarioDuration.p95);
  console.log('    p99: %s', report.scenarioDuration.p99);

  if (_.size(report.customStats) > 0) {
    console.log('Custom stats:');
    _.each(report.customStats, function(r, n) {
      console.log('  %s:', n);
      console.log('    min: %s', r.min);
      console.log('    max: %s', r.max);
      console.log('    median: %s', r.median);
      console.log('    p95: %s', r.p95);
      console.log('    p99: %s', r.p99);
    });
  }

  if (_.keys(report.codes).length !== 0) {
    console.log('  Codes:');
    _.each(report.codes, function(count, code) {
      console.log('    %s: %s', code, count);
    });
  }
  if (_.keys(report.errors).length !== 0) {
    console.log('  Errors:');
    _.each(report.errors, function(count, code) {
      console.log('    %s: %s', code, count);
    });
  }*/
  console.log(util.inspect(assistants, false, null))
}
