/* Old-TV connect flow: intentionally no React or Firebase client SDK. */
export function startLegacyConnect(qrCode) {
  var statusElement = document.getElementById("status");
  var canvas = document.getElementById("qr");
  var pollTimer = null;

  function setStatus(message, isError) {
    statusElement.className = isError ? "error" : "";
    statusElement.textContent = message;
  }

  function callable(name, data, callback) {
    var request = new XMLHttpRequest();
    request.open("POST", "/interactivefoodmenu/europe-west1/" + name, true);
    request.timeout = 15000;
    request.setRequestHeader("Content-Type", "application/json");
    request.onreadystatechange = function () {
      if (request.readyState !== 4) return;
      var body = null;
      try { body = JSON.parse(request.responseText); } catch (ignore) {}
      if (request.status >= 200 && request.status < 300 && body && body.result) {
        callback(null, body.result);
        return;
      }
      var message = body && body.error && body.error.message;
      callback(new Error(message || ("HTTP " + request.status + " — проверьте сеть и сервер")));
    };
    request.onerror = function () { callback(new Error("Нет связи с сервером меню.")); };
    request.ontimeout = function () { callback(new Error("Сервер меню не ответил за 15 секунд.")); };
    try { request.send(JSON.stringify({ data: data })); }
    catch (error) { callback(error); }
  }

  function showError(error) {
    setStatus("Не удалось подключить ТВ: " + (error && error.message ? error.message : "неизвестная ошибка"), true);
  }

  if (!qrCode || !qrCode.toCanvas) {
    showError(new Error("не загрузился генератор QR-кода; обновите страницу"));
    return;
  }

  callable("createDisplayPairing", { displayBaseUrl: window.location.origin }, function (error, pairing) {
    if (error) { showError(error); return; }
    var pairingUrl = pairing.displayBaseUrl + "/pair#" + pairing.pairingToken;
    qrCode.toCanvas(canvas, pairingUrl, { width: 360, margin: 2, errorCorrectionLevel: "M" }, function (qrError) {
      if (qrError) { showError(qrError); return; }
      setStatus("Откройте на телефоне сотрудника и отсканируйте QR-код. Ожидаем подключение…", false);
      pollTimer = window.setInterval(function () {
        callable("getDisplayPairingStatus", { pairingToken: pairing.pairingToken }, function (pollError, result) {
          if (pollError) return;
          if (result.status === "used" && result.displayUrl) {
            window.clearInterval(pollTimer);
            setStatus("Подключено. Загружаем меню…", false);
            window.location.replace(result.displayUrl);
          } else if (result.status === "expired") {
            window.clearInterval(pollTimer);
            setStatus("Код истёк. Обновите страницу, чтобы получить новый QR-код.", true);
          }
        });
      }, 2000);
    });
  });
  window.addEventListener("pagehide", function () { if (pollTimer) window.clearInterval(pollTimer); });
}
