/**
 * ExternalResults API 
 * It's provides a simple way of handling requests and responses between frames 
 * Don't modify the code within this script tag 
 * 
 * TODO - I need to add a mechanism to set the in game currency and formatting
 * 
 */
const version = 'v0.82'
const requestToResolve = {}                    //A map of request ID -> resolve handlers  
const requestTypeToFunctions = {}              //A map of the commandType to function 
let gameIframeId = 'gameIFrame'

function initAPI (config) {
    
    const callbacks = ["ready", "balance", "play", "endPlay"]
    callbacks.map( n => {
        if(config[n] == null) {
            console.error("initAPI expect a config object with these properties gameIframeId, "+callbacks)
            alert("config error")
            return
        } else {
            addRequestHandler(n, config[n])
        }
    })

    if(!config.gameIframeId) {
        console.error("config.gameIframeId not specified")
        alert("config error")
        return
    }
    gameIframeId = config.gameIframeId 
}

let handleEventMessage = function (msg) {
    console.log('Call setEventHandler to handle messages', msg)
}

function setEventHandler (f) {
    handleEventMessage = f
}

/**
 * The main message handler for
 * @param event
 */
function handleMessageFromIFrame (event) {

    let message = (typeof event.data == "string") ? JSON.parse(event.data) : event.data
    console.log("Parent <<< ", message)
    
    if(message.tag == 'GAME_EVENT_MSG') {
        console.log("OTHER MSG RECEIEVED <<< ", message)
        handleEventMessage ( message )                    //TODO tidy this up as it's called below also
        return          //It's some other message
    } else if (message.tag == 'ER_MSG') {
        if(message.type == "event") { 
            handleEventMessage (message)
        } else if(message.type == "request") {
            executeRequestAndRespond(message)
        } else if(message.type == "response") {
            handleResponse(message)
        } else {
            console.warn('Unknown message.type, ignoring', message.type)
        }
    } else {
        console.warn('Unknown message.tag, ignoring', message.type)
    }
}

/**
 * Utility to send a request, then get a promise that will eventually give the response 
 * @param {*} msg 
 * @returns Promise
 */
function request (msg) {
    return new Promise( function(resolve, reject) {
        const m = { type: 'request', id: guid(), data: msg }
        sendMsgToGame(m)
        requestToResolve[m.id] = resolve
    })
}

function sendEventToGame (msg) {
    sendMsgToGame({ type: 'event', id: guid(), data: msg })
}

/**
 * It's a response from an outgoing request we made
 */ 
function handleResponse (message) {
    let resolve = requestToResolve[message.id]
    if(resolve) {
        delete requestToResolve[message.id]
        resolve(message)
        return      //This is already being handled so we return
    }  
    throw "no handle for this response"
}

/**
 * This is an inbound request we need to handle then send back a message with the same guid as a response
 * @param message
 */
function executeRequestAndRespond (message) {
    const someFunc = requestTypeToFunctions[message.data.commandType]
    if(someFunc) {
        someFunc(message.data).then(val => {
            val.commandType = message.data.commandType
            sendMsgToGame({ type: 'response', id: message.id, data: val })
            })
    } else {
        console.warn("No request handler found for ", message)
    }

}

/**
 * Sends a message to the game
 */ 
function sendMsgToGame (msg) {
    try { 
        msg.tag = 'ER_MSG'
        document.getElementById(gameIframeId).contentWindow.postMessage(msg, "*")
        console.log("Parent >>> ", msg)
    } catch (ex) {
        console.log(ex)	
    }
}

function guid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0; var v = c === 'x' ? r : (r & 3 | 8)
    return v.toString(16);
    })
}

function addRequestHandler (type, f) {
    requestTypeToFunctions[type] = f
}

window.addEventListener('message', handleMessageFromIFrame)         //THIS NEEDS TO BE ADDED BEFORE THE GAME IS LOADED
