const publicVapidKey =
  "BB2ikt9eLJydNI-1LpnaRYiogis3ydcUEw6O615fhaHsOsRRHcMZUfVSTNqun6HVb44M6PdfviDJkMWsdTO7XcM"


async function updateWebSlider() {
    console.log("updateWebSlider")
    if(document.getElementById("webSlider").checked){
        await subscribe();
    }else{
        await unsubscribe();
    }       
}

async function sendNotification() {
    await fetch("/message", {
        method: "POST",
        body: JSON.stringify({
            message: {
                user: "User",
                text:"Message"
            }
        }),
        headers: {
          "content-type": "application/json"
        }
    });
}

//Subscibes the user and sends a test notification
async function subscribe() {
  const subscription_str = await getSubscriptionString();
  
  // Send Push Notification
  console.log("Sending Push..." + subscription_str);
  await fetch("/subscribe", {
    method: "POST",
    body: subscription_str,
    headers: {
      "content-type": "application/json"
    }
  });
  console.log("Push Sent...");
}

//Returns a token for sending notifications to client
async function getSubscriptionString(){
  console.log("Registering service worker...");
  const register = await navigator.serviceWorker.register("worker.js", {
    scope: "/chat/"
  });
  console.log("Service Worker Registered...");
  console.log("Registering Push...");
  const subscription = await register.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
  });
  console.log("Push Registered...");
  return JSON.stringify(subscription)
}


//Sends a server token, and tells it to remove from batch
async function unsubscribe() {
  console.log("remove()")
  const subscription_str = await getSubscriptionString();
  // Send Push Notification
  console.log("Sending Push for removal...");
  await fetch("/chat/unsubscribe", {
    method: "POST",
    body: subscription_str,
    headers: {
      "content-type": "application/json"
    }
  });
  console.log("Push Sent to remove user from list...");
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

 //handles the size of input
 function inputSize(){
    let textarea = document.getElementById("send-box");
    let headerSize = '40'
    var taLineHeight = 45
    if(screen.width < 800){
       headerSize = '100';
       taLineHeight = 45;
    }
    let textAreaHeight = 85;
    let gridContainer = document.getElementById("grid-container");
    gridContainer.style.gridTemplateRows = `${headerSize}px auto 85px 1.5em`
    var taHeight = textarea.scrollHeight; // Get the scroll height of the textarea
    textarea.style.height = taHeight;
    var numberOfLines = Math.floor(taHeight/taLineHeight);
    if(numberOfLines == 1){
       gridContainer.style.gridTemplateRows = `${headerSize}px auto 85px 1.5em`
    }else if(numberOfLines == 2){
       gridContainer.style.gridTemplateRows = `${headerSize}px auto 125px 1.5em`
    }else if(numberOfLines == 3){
       gridContainer.style.gridTemplateRows = `${headerSize}px auto 175px 1.5em`
    }else if(numberOfLines >= 4){
       gridContainer.style.gridTemplateRows = `${headerSize}px auto 220px 1.5em`
    }

    var message_view = document.getElementById("react-messages");
    message_view.scrollTop = message_view.scrollHeight;
 }

 //If safari mobile, then the screen needs to be cut at the bottom
function screenSize(){
    if(screen.width < 800){
        var ua = navigator.userAgent.toLowerCase();
        if (ua.indexOf('safari') != -1) {
            if (ua.indexOf('chrome') > -1) {
                // Chrome
            } else {
                console.log("safari movbile")
                document.body.style.height = '90vh';
            }
        }
    }
}
