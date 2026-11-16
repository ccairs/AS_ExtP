/*
* CSInterface - v8.0.0
* Adobe Common Extensibility Platform
*
* Copyright (c) 2012-2017 Adobe Systems Inc.
* All Rights Reserved.
*
* NOTICE:  Adobe permits you to use, modify, and distribute this file in
* accordance with the terms of the Adobe license agreement accompanying it.
*/

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global window, CSInterface, JSON, alert */

/**
 * @private
 */
(function () {
    'use strict';

    if (window.CSInterface) {
        return;
    }

    /**
     * @class CSInterface
     * @classdesc The CSInterface object is the entry point for accessing the CEP extensibility infrastructure.
     * @description Creates a new CSInterface instance.
     * @example
     * //Create an instance.
     * var csInterface = new CSInterface();
     */
    window.CSInterface = function () {
    };

    /**
     * @private
     */
    CSInterface.prototype = {

        /**
         * @readonly
         * @type {string}
         * @description The version of the CSInterface library.
         */
        VERSION: '8.0.0',

        /**
         * @readonly
         * @type {string}
         * @description The minimum version of CEP required.
         */
        MIN_CEP_VERSION: '8.0',

        /**
         * Closes the extension.
         * @function closeExtension
         * @memberof CSInterface
         * @instance
         */
        closeExtension: function () {
            this._call('closeExtension');
        },

        /**
         * Evaluates a JavaScript script string in the ExtendScript context of the host application.
         * @function evalScript
         * @memberof CSInterface
         * @instance
         * @param {string} script The JavaScript script string to evaluate.
         * @param {function} [callback] A callback function that receives the result of the evaluation.
         * @example
         * //Call evalScript with a callback.
         * csInterface.evalScript('app.version', function(result) {
         *     console.log('app.version = ' + result);
         * });
         */
        evalScript: function (script, callback) {
            if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === 'function') {
                return window.__adobe_cep__.evalScript(script, callback);
            }
            return this._call('evalScript', script, callback);
        },

        /**
         * Retrieves information about the host application.
         * @function getApplicationID
         * @memberof CSInterface
         * @instance
         * @return {string} The unique identifier of the host application.
         * @example
         * console.log('App ID: ' + csInterface.getApplicationID());
         */
        getApplicationID: function () {
            return this._call('getApplicationID');
        },

        /**
         * Retrieves the application language.
         * @function getApplicationLanguage
         * @memberof CSInterface
         * @instance
         * @return {string} The language code of the host application.
         * @example
         * console.log('App language: ' + csInterface.getApplicationLanguage());
         */
        getApplicationLanguage: function () {
            return this._call('getApplicationLanguage');
        },

        /**
         * Retrieves the application version.
         * @function getApplicationVersion
         * @memberof CSInterface
         * @instance
         * @return {string} The version string of the host application.
         * @example
         * console.log('App version: ' + csInterface.getApplicationVersion());
         */
        getApplicationVersion: function () {
            return this._call('getApplicationVersion');
        },

        /**
         * Retrieves the path to the common files folder for all Creative Cloud applications.
         * @function getCommonFolder
         * @memberof CSInterface
         * @instance
         * @param {string} folderType The type of common folder to retrieve. Use values of the FolderType enum.
         * @return {string} The path to the specified type of common folder.
         * @example
         * console.log('Common folder: ' + csInterface.getCommonFolder(Window.FolderType.TEMPLATES));
         */
        getCommonFolder: function (folderType) {
            return this._call('getCommonFolder', folderType);
        },

        /**
         * Retrieves the path to the current extension's folder.
         * @function getExtensionPath
         * @memberof CSInterface
         * @instance
         * @return {string} The path to the folder containing the current extension.
         * @example
         * console.log('Extension path: ' + csInterface.getExtensionPath());
         */
        getExtensionPath: function () {
            return this._call('getExtensionPath');
        },

        /**
         * Retrieves the path to a standard system location.
         * @function getSystemPath
         * @memberof CSInterface
         * @instance
         * @param {string} pathType The type of system path (e.g. "extension", "userData").
         * @return {string} The path to the specified system location.
         */
        getSystemPath: function (pathType) {
            return this._call('getSystemPath', pathType);
        },

        /**
         * Retrieves the unique identifier of the current extension.
         * @function getExtensionID
         * @memberof CSInterface
         * @instance
         * @return {string} The unique identifier of the current extension.
         * @example
         * console.log('Extension ID: ' + csInterface.getExtensionID());
         */
        getExtensionID: function () {
            return this._call('getExtensionID');
        },

        /**
         * Retrieves information about the host environment.
         * @function getHostEnvironment
         * @memberof CSInterface
         * @instance
         * @return {object} A JavaScript object containing information about the host environment.
         * @example
         * console.log('Host environment: ' + JSON.stringify(csInterface.getHostEnvironment()));
         */
        getHostEnvironment: function () {
            var result = this._call('getHostEnvironment');
            try {
                result = JSON.parse(result);
            } catch (e) {
                console.error('Failed to parse host environment JSON: ' + e.message);
                result = {};
            }
            return result;
        },

        /**
         * Retrieves the path to a folder for the current user.
         * @function getUserFolder
         * @memberof CSInterface
         * @instance
         * @param {string} folderType The type of user folder to retrieve. Use values of the FolderType enum.
         * @return {string} The path to the specified type of user folder.
         * @example
         * console.log('User folder: ' + csInterface.getUserFolder(Window.FolderType.DESKTOP));
         */
        getUserFolder: function (folderType) {
            return this._call('getUserFolder', folderType);
        },

        /**
         * Registers a callback function to handle events dispatched by the host application.
         * @function registerEventListener
         * @memberof CSInterface
         * @instance
         * @param {string} eventType The type of event to listen for.
         * @param {function} callback The function to call when the event occurs.
         * @example
         * //Register an event listener.
         * csInterface.registerEventListener('documentAfterActivate', function(event) {
         *     console.log('Document activated: ' + JSON.stringify(event));
         * });
         */
        registerEventListener: function (eventType, callback) {
            this._call('registerEventListener', eventType, callback);
        },

        /**
         * Removes a previously registered event listener.
         * @function removeEventListener
         * @memberof CSInterface
         * @instance
         * @param {string} eventType The type of event to stop listening for.
         * @param {function} callback The function that was registered as the callback.
         * @example
         * //Remove an event listener.
         * csInterface.removeEventListener('documentAfterActivate', myCallbackFunction);
         */
        removeEventListener: function (eventType, callback) {
            this._call('removeEventListener', eventType, callback);
        },

        /**
         * Dispatches an event to the host application.
         * @function dispatchEvent
         * @memberof CSInterface
         * @instance
         * @param {string} eventType The type of event to dispatch.
         * @param {object} data Additional data to pass with the event.
         * @example
         * //Dispatch an event.
         * csInterface.dispatchEvent('myCustomEvent', {message: 'Hello from extension'});
         */
        dispatchEvent: function (eventType, data) {
            this._call('dispatchEvent', eventType, data);
        },

        /**
         * Opens a page in the default browser.
         * @function openURLInDefaultBrowser
         * @memberof CSInterface
         * @instance
         * @param {string} url The URL of the page to open.
         * @example
         * //Open a URL in the default browser.
         * csInterface.openURLInDefaultBrowser('https://www.adobe.com');
         */
        openURLInDefaultBrowser: function (url) {
            this._call('openURLInDefaultBrowser', url);
        },

        /**
         * @private
         */
        _call: function (name, args, callback) {
            if (typeof args === 'function') {
                callback = args;
                args = [];
            }
            if (!args) {
                args = [];
            }
            if (!Array.isArray(args)) {
                args = [args];
            }

            var result = window.__adobe_cep__[name].apply(window.__adobe_cep__, args);
            if (callback) {
                callback(result);
            }
            return result;
        }
    };

    /**
     * @enum
     * @memberof CSInterface
     * @description Constants for standard folder types.
     */
    CSInterface.prototype.FolderType = {
        APPLICATION: 'APPLICATION',
        DOCUMENTS: 'DOCUMENTS',
        DESKTOP: 'DESKTOP',
        FONTS: 'FONTS',
        PREFERENCES: 'PREFERENCES',
        TEMPLATES: 'TEMPLATES',
        USER_DATA: 'USER_DATA',
        USER_PREFERENCES: 'USER_PREFERENCES',
        COMMON_FILES: 'COMMON_FILES',
        EXTENSIONS: 'EXTENSIONS'
    };

    /**
     * @enum
     * @memberof CSInterface
     * @description Constants for standard application IDs.
     */
    CSInterface.prototype.ApplicationID = {
        PHOTOSHOP: 'PHSP',
        ILLUSTRATOR: 'ILST',
        PREMIERE_PRO: 'PRMI',
        AFTER_EFFECTS: 'AEFT',
        INDESIGN: 'IDSN',
        INCOPY: 'AICY',
        AUDITION: 'AUDT',
        DREAMWEAVER: 'DRWV',
        FLASH_PRO: 'FLPR',
        FIREWORKS: 'FWKS',
        PRELUDE: 'PRLD',
        ACROBAT: 'ACR',
        BRIDGE: 'KBRG',
        MEDIA_ENCODER: 'AME',
        EXTENSION_MANAGER: 'EXMG'
    };

    /**
     * @enum
     * @memberof CSInterface
     * @description Constants for standard event types.
     */
    CSInterface.prototype.EventType = {
        APP_AFTER_LAUNCH: 'appAfterLaunch',
        APP_BEFORE_QUIT: 'appBeforeQuit',
        APP_CLOSE_DOCUMENT: 'appCloseDocument',
        APP_NEW_DOCUMENT: 'appNewDocument',
        APP_OPEN_DOCUMENT: 'appOpenDocument',
        APP_ACTIVATE: 'appActivate',
        APP_DEACTIVATE: 'appDeactivate',
        DOCUMENT_AFTER_ACTIVATE: 'documentAfterActivate',
        DOCUMENT_BEFORE_DEACTIVATE: 'documentBeforeDeactivate',
        DOCUMENT_CHANGED: 'documentChanged',
        DOCUMENT_CLOSE: 'documentClose',
        DOCUMENT_NEW: 'documentNew',
        DOCUMENT_OPEN: 'documentOpen',
        DOCUMENT_SAVE: 'documentSave'
    };

}());
