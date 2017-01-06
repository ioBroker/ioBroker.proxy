![Logo](admin/simple-api.png)
ioBroker simple-api adapter
=================
[![NPM version](http://img.shields.io/npm/v/iobroker.simple-api.svg)](https://www.npmjs.com/package/iobroker.simple-api)
[![Downloads](https://img.shields.io/npm/dm/iobroker.simple-api.svg)](https://www.npmjs.com/package/iobroker.simple-api)
[![Tests](https://travis-ci.org/ioBroker/ioBroker.simple-api.svg?branch=master)](https://travis-ci.org/ioBroker/ioBroker.simple-api)

[![NPM](https://nodei.co/npm/iobroker.simple-api.png?downloads=true)](https://nodei.co/npm/iobroker.simple-api/)

This is RESTFul interface to read the objects and states from ioBroker and to write/control the states over HTTP Get/Post requests.

## Sample settings
| regex          |      URL                                           |
|----------------|:--------------------------------------------------:|
| camFloor/*     | http://ipcam:1234/                                 |
| camFloorPic    | http://ipcam:1234/snapshot.cgi?user=name&pass=pass |
| secureCam      | https://secondCam/snapshot.cgi?user=name&pass=pass |


The user can define internal URLs like "http://webcam/snapshot.jpg" and can access it via WEB adapter.

## Changelog

### 0.0.1 (2017-01-06)
* (bluefox) initial commit