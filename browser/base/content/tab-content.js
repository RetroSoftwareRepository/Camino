/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This content script contains code that requires a tab browser. */

var {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/ExtensionContent.jsm");

const g104FxForcePref = "tenfourfox.reader.force-enable"; // TenFourFox issue 583
const g104FxStickyPref = "tenfourfox.reader.sticky"; // TenFourFox issue 620
const g104FxAutoPref = "tenfourfox.reader.auto."; // TenFourFox issue 636

Cu.import("resource://gre/modules/Preferences.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "E10SUtils",
  "resource:///modules/E10SUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "BrowserUtils",
  "resource://gre/modules/BrowserUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils",
  "resource://gre/modules/PrivateBrowsingUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "AboutReader",
  "resource://gre/modules/AboutReader.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ReaderMode",
  "resource://gre/modules/ReaderMode.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Readerable",
  "resource://gre/modules/Readerable.jsm");
XPCOMUtils.defineLazyGetter(this, "SimpleServiceDiscovery", function() {
  let ssdp = Cu.import("resource://gre/modules/SimpleServiceDiscovery.jsm", {}).SimpleServiceDiscovery;
  // Register targets
  ssdp.registerDevice({
    id: "roku:ecp",
    target: "roku:ecp",
    factory: function(aService) {
      Cu.import("resource://gre/modules/RokuApp.jsm");
      return new RokuApp(aService);
    },
    types: ["video/mp4"],
    extensions: ["mp4"]
  });
  return ssdp;
});

// TabChildGlobal
var global = this;


addMessageListener("Browser:HideSessionRestoreButton", function (message) {
  // Hide session restore button on about:home
  let doc = content.document;
  let container;
  if (doc.documentURI.toLowerCase() == "about:home" &&
      (container = doc.getElementById("sessionRestoreContainer"))) {
    container.hidden = true;
  }
});


addMessageListener("Browser:Reload", function(message) {
  /* First, we'll try to use the session history object to reload so
   * that framesets are handled properly. If we're in a special
   * window (such as view-source) that has no session history, fall
   * back on using the web navigation's reload method.
   */

  let webNav = docShell.QueryInterface(Ci.nsIWebNavigation);
  try {
    let sh = webNav.sessionHistory;
    if (sh)
      webNav = sh.QueryInterface(Ci.nsIWebNavigation);
  } catch (e) {
  }

  let reloadFlags = message.data.flags;
  let handlingUserInput;
  try {
    handlingUserInput = content.QueryInterface(Ci.nsIInterfaceRequestor)
                               .getInterface(Ci.nsIDOMWindowUtils)
                               .setHandlingUserInput(message.data.handlingUserInput);
    webNav.reload(reloadFlags);
  } catch (e) {
  } finally {
    handlingUserInput.destruct();
  }
});

addMessageListener("MixedContent:ReenableProtection", function() {
  docShell.mixedContentChannel = null;
});

addMessageListener("SecondScreen:tab-mirror", function(message) {
  if (!Services.prefs.getBoolPref("browser.casting.enabled")) {
    return;
  }
  let app = SimpleServiceDiscovery.findAppForService(message.data.service);
  if (app) {
    let width = content.innerWidth;
    let height = content.innerHeight;
    let viewport = {cssWidth: width, cssHeight: height, width: width, height: height};
    app.mirror(function() {}, content, viewport, function() {}, content);
  }
});

var AboutHomeListener = {
  init: function(chromeGlobal) {
    chromeGlobal.addEventListener('AboutHomeLoad', this, false, true);
  },

  get isAboutHome() {
    return content.document.documentURI.toLowerCase() == "about:home";
  },

  handleEvent: function(aEvent) {
    if (!this.isAboutHome) {
      return;
    }
    switch (aEvent.type) {
      case "AboutHomeLoad":
        this.onPageLoad();
        break;
      case "click":
        this.onClick(aEvent);
        break;
      case "pagehide":
        this.onPageHide(aEvent);
        break;
    }
  },

  receiveMessage: function(aMessage) {
    if (!this.isAboutHome) {
      return;
    }
    switch (aMessage.name) {
      case "AboutHome:Update":
        this.onUpdate(aMessage.data);
        break;
    }
  },

  onUpdate: function(aData) {
    let doc = content.document;
    if (aData.showRestoreLastSession && !PrivateBrowsingUtils.isContentWindowPrivate(content))
      doc.getElementById("launcher").setAttribute("session", "true");

    // Inject search engine and snippets URL.
    let docElt = doc.documentElement;
    // Set snippetsVersion last, which triggers to show the snippets when it's set.
    docElt.setAttribute("snippetsURL", aData.snippetsURL);
    if (aData.showKnowYourRights)
      docElt.setAttribute("showKnowYourRights", "true");
    docElt.setAttribute("snippetsVersion", aData.snippetsVersion);
  },

  onPageLoad: function() {
    let doc = content.document;
    if (doc.documentElement.hasAttribute("hasBrowserHandlers")) {
      return;
    }

    doc.documentElement.setAttribute("hasBrowserHandlers", "true");
    addMessageListener("AboutHome:Update", this);
    addEventListener("click", this, true);
    addEventListener("pagehide", this, true);

    sendAsyncMessage("AboutHome:RequestUpdate");
  },

  onClick: function(aEvent) {
    if (!aEvent.isTrusted || // Don't trust synthetic events
        aEvent.button == 2 || aEvent.target.localName != "button") {
      return;
    }

    let originalTarget = aEvent.originalTarget;
    let ownerDoc = originalTarget.ownerDocument;
    if (ownerDoc.documentURI != "about:home") {
      // This shouldn't happen, but we're being defensive.
      return;
    }

    let elmId = originalTarget.getAttribute("id");

    switch (elmId) {
      case "restorePreviousSession":
        sendAsyncMessage("AboutHome:RestorePreviousSession");
        ownerDoc.getElementById("launcher").removeAttribute("session");
        break;

      case "downloads":
        sendAsyncMessage("AboutHome:Downloads");
        break;

      case "bookmarks":
        sendAsyncMessage("AboutHome:Bookmarks");
        break;

      case "history":
        sendAsyncMessage("AboutHome:History");
        break;

      case "addons":
        sendAsyncMessage("AboutHome:Addons");
        break;

      case "sync":
        sendAsyncMessage("AboutHome:Sync");
        break;

      case "settings":
        sendAsyncMessage("AboutHome:Settings");
        break;
    }
  },

  onPageHide: function(aEvent) {
    if (aEvent.target.defaultView.frameElement) {
      return;
    }
    removeMessageListener("AboutHome:Update", this);
    removeEventListener("click", this, true);
    removeEventListener("pagehide", this, true);
    if (aEvent.target.documentElement) {
      aEvent.target.documentElement.removeAttribute("hasBrowserHandlers");
    }
  },
};
AboutHomeListener.init(this);

var AboutPrivateBrowsingListener = {
  init(chromeGlobal) {
    chromeGlobal.addEventListener("AboutPrivateBrowsingOpenWindow", this,
                                  false, true);
    chromeGlobal.addEventListener("AboutPrivateBrowsingToggleTrackingProtection", this,
                                  false, true);
  },

  get isAboutPrivateBrowsing() {
    return content.document.documentURI.toLowerCase() == "about:privatebrowsing";
  },

  handleEvent(aEvent) {
    if (!this.isAboutPrivateBrowsing) {
      return;
    }
    switch (aEvent.type) {
      case "AboutPrivateBrowsingOpenWindow":
        sendAsyncMessage("AboutPrivateBrowsing:OpenPrivateWindow");
        break;
      case "AboutPrivateBrowsingToggleTrackingProtection":
        sendAsyncMessage("AboutPrivateBrowsing:ToggleTrackingProtection");
        break;
    }
  },
};
AboutPrivateBrowsingListener.init(this);

var AboutReaderListener = {

  _articlePromise: null,
  _alwaysAllowReaderMode: true, // TenFourFox issue 583
  _stickyReaderMode: true, // TenFourFox issue 620
  _currentURISpec: null, // TenFourFox issue 636

  init: function() {
    addEventListener("AboutReaderContentLoaded", this, false, true);
    addEventListener("DOMContentLoaded", this, false);
    addEventListener("pageshow", this, false);
    addEventListener("pagehide", this, false);
    addMessageListener("Reader:ParseDocument", this);
    addMessageListener("Reader:PushState", this);
    Services.prefs.addObserver(g104FxForcePref, this, false);
    Services.prefs.addObserver(g104FxStickyPref, this, false);
    Services.obs.addObserver(this, "AboutReader:Ready", false);
    /* content-document-global-created seems to NS_ASSERT */
    Services.obs.addObserver(this, "document-element-inserted", false);
  },

  // TenFourFox issue 583 + 636
  uninit: function() {
    Services.prefs.removeObserver(g104FxForcePref, this, false);
    Services.obs.removeObserver(this, "AboutReader:Ready");
    Services.obs.removeObserver(this, "document-element-inserted");
  },
  observe: function(subject, topic, data) { // jshint ignore:line
    if (topic === "nsPref:changed") {
      this._alwaysAllowReaderMode = Preferences.get(g104FxForcePref, true);
      this._stickyReaderMode = Preferences.get(g104FxStickyPref, true);
    }
    if (topic === "AboutReader:Ready") {
      this.stickyReaderLinks();
    }
    if (topic === "document-element-inserted") { // TenFourFox issue 636
      this.doAutoReaderView();
    }
  },

  // TenFourFox issue 636
  doAutoReaderView: function() {
    if (!content || this.isAboutReader)
      return;

    if (!content.document.documentURI.startsWith("http:") &&
        !content.document.documentURI.startsWith("https")) {
      /* could be another about: page, could be ftp, ... */
      this._currentURISpec = null;
      return;
    }

    /* if we ended up back here because we explicitly exited Reader View on
       the same URL, then honour what the user probably wants. */
    let loc = content.document.location;
    if (this._currentURISpec == loc.href) return;
    this._currentURISpec = loc.href;

    /* process into an nsIURI. this gives us a reliable host *and* spec w/o ref */
    let uri = Services.io.newURI(loc.href, null, null);
    if (uri && uri.host && uri.host.length && uri.host.length > 0) {
      let w = null;
      try {
        w = Services.prefs.getCharPref(g104FxAutoPref + uri.host);
      } catch(e) { }
      if (w && w.length && w.length > 0) {
        if (w == "y") {
          this._currentURISpec = uri.specIgnoringRef; // might change
          loc.replace("about:reader?url="+encodeURIComponent(uri.specIgnoringRef));
          return;
        }
        if (w == "s") {
          if (uri.path && uri.path.length && uri.path != "" && uri.path != "/"
              && !uri.path.startsWith("/?")
              && !uri.path.toLowerCase().startsWith("/index.")
             ) {
            this._currentURISpec = uri.specIgnoringRef; // might change
            loc.replace("about:reader?url="+encodeURIComponent(uri.specIgnoringRef));
            return;
          }
        }
      }
    }
  },

  receiveMessage: function(message) {
    switch (message.name) {
      case "Reader:ParseDocument":
        this._articlePromise = ReaderMode.parseDocument(content.document).catch(Cu.reportError);
        content.document.location = "about:reader?url=" + encodeURIComponent(message.data.url);
        break;

      case "Reader:PushState":
        this.updateReaderButton(!!(message.data && message.data.isArticle));
        break;
    }
  },

  get isAboutReader() {
    if (!content) {
      return false;
    }
    return content.document.documentURI.startsWith("about:reader");
  },

  handleEvent: function(aEvent) {
    if (aEvent.originalTarget.defaultView != content) {
      return;
    }

    switch (aEvent.type) {
      case "AboutReaderContentLoaded":
        if (!this.isAboutReader) {
          return;
        }

        if (content.document.body) {
          // Update the toolbar icon to show the "reader active" icon.
          sendAsyncMessage("Reader:UpdateReaderButton");
          new AboutReader(global, content, this._articlePromise);
          this._articlePromise = null;
        }
        break;

      case "pagehide":
        this.cancelPotentialPendingReadabilityCheck();
        sendAsyncMessage("Reader:UpdateReaderButton", { isArticle: false });
        break;

      case "pageshow":
        // If a page is loaded from the bfcache, we won't get a "DOMContentLoaded"
        // event, so we need to rely on "pageshow" in this case.
        if (aEvent.persisted) {
          this.updateReaderButton();
        }
        break;
      case "DOMContentLoaded":
        this.updateReaderButton();
        break;

    }
  },

  /**
   * NB: this function will update the state of the reader button asynchronously
   * after the next mozAfterPaint call (assuming reader mode is enabled and
   * this is a suitable document). Calling it on things which won't be
   * painted is not going to work.
   */
  updateReaderButton: function(forceNonArticle) {
    if (!Readerable.isEnabledForParseOnLoad || this.isAboutReader ||
        !(content.document instanceof content.HTMLDocument) ||
        content.document.mozSyntheticDocument) {
      return;
    }

    this.scheduleReadabilityCheckPostPaint(forceNonArticle);
  },

  stickyReaderLinks: function() { /* TenFourFox issue 620 */
    if (!this.isAboutReader || !this._stickyReaderMode) return;

    let i = 0;
    let ls = content.document.links;
    if (!ls || !ls.length || ls.length == 0) return;

    for (i=0; i<ls.length; i++) {
      if (ls[i].href && ls[i].href.startsWith("http"))
        ls[i].href = "about:reader?url=" + encodeURIComponent(ls[i].href);
/*
        ls[i].onclick = function() {
		this.href='about:reader?url='+encodeURIComponent(this.href);
	};
*/
    }
  },

  cancelPotentialPendingReadabilityCheck: function() {
    if (this._pendingReadabilityCheck) {
      removeEventListener("MozAfterPaint", this._pendingReadabilityCheck);
      delete this._pendingReadabilityCheck;
    }
  },

  scheduleReadabilityCheckPostPaint: function(forceNonArticle) {
    if (this._pendingReadabilityCheck) {
      // We need to stop this check before we re-add one because we don't know
      // if forceNonArticle was true or false last time.
      this.cancelPotentialPendingReadabilityCheck();
    }
    this._pendingReadabilityCheck = this.onPaintWhenWaitedFor.bind(this, forceNonArticle);
    addEventListener("MozAfterPaint", this._pendingReadabilityCheck);
  },

  onPaintWhenWaitedFor: function(forceNonArticle) {
    this.cancelPotentialPendingReadabilityCheck();

    let doc = content.document;
    if (!doc) return;

    // TenFourFox issue 583
    // If we are always allowing reader mode, don't bother spending any time
    // processing the page. But don't let just everything through.
    if (!this.isAboutReader && this._alwaysAllowReaderMode) {
      // This borrows a bit from isProbablyReaderable()
      if (!doc.mozSyntheticDocument &&
           doc instanceof doc.defaultView.HTMLDocument) {
        let uri = Services.io.newURI(doc.location.href, null, null);
        if (uri && Readerable.shouldCheckUri(uri)) {
          sendAsyncMessage("Reader:UpdateReaderButton", { isArticle: true });
          return;
        }
      }
    }

    // Only send updates when there are articles; there's no point updating with
    // |false| all the time.
    if (Readerable.isProbablyReaderable(content.document)) {
      sendAsyncMessage("Reader:UpdateReaderButton", { isArticle: true });
    } else if (forceNonArticle) {
      sendAsyncMessage("Reader:UpdateReaderButton", { isArticle: false });
    }
  },
};
AboutReaderListener.init();


var ContentSearchMediator = {

  whitelist: new Set([
    "about:home",
    "about:newtab",
  ]),

  init: function (chromeGlobal) {
    chromeGlobal.addEventListener("ContentSearchClient", this, true, true);
    addMessageListener("ContentSearch", this);
  },

  handleEvent: function (event) {
    if (this._contentWhitelisted) {
      this._sendMsg(event.detail.type, event.detail.data);
    }
  },

  receiveMessage: function (msg) {
    if (msg.data.type == "AddToWhitelist") {
      for (let uri of msg.data.data) {
        this.whitelist.add(uri);
      }
      this._sendMsg("AddToWhitelistAck");
      return;
    }
    if (this._contentWhitelisted) {
      this._fireEvent(msg.data.type, msg.data.data);
    }
  },

  get _contentWhitelisted() {
    return this.whitelist.has(content.document.documentURI);
  },

  _sendMsg: function (type, data=null) {
    sendAsyncMessage("ContentSearch", {
      type: type,
      data: data,
    });
  },

  _fireEvent: function (type, data=null) {
    let event = Cu.cloneInto({
      detail: {
        type: type,
        data: data,
      },
    }, content);
    content.dispatchEvent(new content.CustomEvent("ContentSearchService",
                                                  event));
  },
};
ContentSearchMediator.init(this);

var PageStyleHandler = {
  init: function() {
    addMessageListener("PageStyle:Switch", this);
    addMessageListener("PageStyle:Disable", this);
    addEventListener("pageshow", () => this.sendStyleSheetInfo());
  },

  get markupDocumentViewer() {
    return docShell.contentViewer;
  },

  sendStyleSheetInfo: function() {
    let filteredStyleSheets = this._filterStyleSheets(this.getAllStyleSheets());

    sendAsyncMessage("PageStyle:StyleSheets", {
      filteredStyleSheets: filteredStyleSheets,
      authorStyleDisabled: this.markupDocumentViewer.authorStyleDisabled,
      preferredStyleSheetSet: content.document.preferredStyleSheetSet
    });
  },

  getAllStyleSheets: function(frameset = content) {
    let selfSheets = Array.slice(frameset.document.styleSheets);
    let subSheets = Array.map(frameset.frames, frame => this.getAllStyleSheets(frame));
    return selfSheets.concat(...subSheets);
  },

  receiveMessage: function(msg) {
    switch (msg.name) {
      case "PageStyle:Switch":
        this.markupDocumentViewer.authorStyleDisabled = false;
        this._stylesheetSwitchAll(content, msg.data.title);
        break;

      case "PageStyle:Disable":
        this.markupDocumentViewer.authorStyleDisabled = true;
        break;
    }

    this.sendStyleSheetInfo();
  },

  _stylesheetSwitchAll: function (frameset, title) {
    if (!title || this._stylesheetInFrame(frameset, title)) {
      this._stylesheetSwitchFrame(frameset, title);
    }

    for (let i = 0; i < frameset.frames.length; i++) {
      // Recurse into sub-frames.
      this._stylesheetSwitchAll(frameset.frames[i], title);
    }
  },

  _stylesheetSwitchFrame: function (frame, title) {
    var docStyleSheets = frame.document.styleSheets;

    for (let i = 0; i < docStyleSheets.length; ++i) {
      let docStyleSheet = docStyleSheets[i];
      if (docStyleSheet.title) {
        docStyleSheet.disabled = (docStyleSheet.title != title);
      } else if (docStyleSheet.disabled) {
        docStyleSheet.disabled = false;
      }
    }
  },

  _stylesheetInFrame: function (frame, title) {
    return Array.some(frame.document.styleSheets, (styleSheet) => styleSheet.title == title);
  },

  _filterStyleSheets: function(styleSheets) {
    let result = [];

    for (let currentStyleSheet of styleSheets) {
      if (!currentStyleSheet.title)
        continue;

      // Skip any stylesheets that don't match the screen media type.
      if (currentStyleSheet.media.length > 0) {
        let mediaQueryList = currentStyleSheet.media.mediaText;
        if (!content.matchMedia(mediaQueryList).matches) {
          continue;
        }
      }

      let URI;
      try {
        URI = Services.io.newURI(currentStyleSheet.href, null, null);
      } catch(e) {
        if (e.result != Cr.NS_ERROR_MALFORMED_URI) {
          throw e;
        }
      }

      if (URI) {
        // We won't send data URIs all of the way up to the parent, as these
        // can be arbitrarily large.
        let sentURI = URI.scheme == "data" ? null : URI.spec;

        result.push({
          title: currentStyleSheet.title,
          disabled: currentStyleSheet.disabled,
          href: sentURI,
        });
      }
    }

    return result;
  },
};
PageStyleHandler.init();

// Keep a reference to the translation content handler to avoid it it being GC'ed.
var trHandler = null;
if (Services.prefs.getBoolPref("browser.translation.detectLanguage")) {
  Cu.import("resource:///modules/translation/TranslationContentHandler.jsm");
  trHandler = new TranslationContentHandler(global, docShell);
}

function gKeywordURIFixup(fixupInfo) {
  fixupInfo.QueryInterface(Ci.nsIURIFixupInfo);
  if (!fixupInfo.consumer) {
    return;
  }

  // Ignore info from other docshells
  let parent = fixupInfo.consumer.QueryInterface(Ci.nsIDocShellTreeItem).sameTypeRootTreeItem;
  if (parent != docShell)
    return;

  let data = {};
  for (let f of Object.keys(fixupInfo)) {
    if (f == "consumer" || typeof fixupInfo[f] == "function")
      continue;

    if (fixupInfo[f] && fixupInfo[f] instanceof Ci.nsIURI) {
      data[f] = fixupInfo[f].spec;
    } else {
      data[f] = fixupInfo[f];
    }
  }

  sendAsyncMessage("Browser:URIFixup", data);
}
Services.obs.addObserver(gKeywordURIFixup, "keyword-uri-fixup", false);
addEventListener("unload", () => {
  Services.obs.removeObserver(gKeywordURIFixup, "keyword-uri-fixup");
}, false);

addMessageListener("Browser:AppTab", function(message) {
  if (docShell) {
    docShell.isAppTab = message.data.isAppTab;
  }
});

var WebBrowserChrome = {
  onBeforeLinkTraversal: function(originalTarget, linkURI, linkNode, isAppTab) {
    return BrowserUtils.onBeforeLinkTraversal(originalTarget, linkURI, linkNode, isAppTab);
  },

  // Check whether this URI should load in the current process
  shouldLoadURI: function(aDocShell, aURI, aReferrer) {
    if (!E10SUtils.shouldLoadURI(aDocShell, aURI, aReferrer)) {
      E10SUtils.redirectLoad(aDocShell, aURI, aReferrer);
      return false;
    }

    return true;
  },
};

if (Services.appinfo.processType == Services.appinfo.PROCESS_TYPE_CONTENT) {
  let tabchild = docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                         .getInterface(Ci.nsITabChild);
  tabchild.webBrowserChrome = WebBrowserChrome;
}


var DOMFullscreenHandler = {
  _fullscreenDoc: null,

  init: function() {
    addMessageListener("DOMFullscreen:Entered", this);
    addMessageListener("DOMFullscreen:CleanUp", this);
    addEventListener("MozDOMFullscreen:Request", this);
    addEventListener("MozDOMFullscreen:Entered", this);
    addEventListener("MozDOMFullscreen:NewOrigin", this);
    addEventListener("MozDOMFullscreen:Exit", this);
    addEventListener("MozDOMFullscreen:Exited", this);
  },

  get _windowUtils() {
    return content.QueryInterface(Ci.nsIInterfaceRequestor)
                  .getInterface(Ci.nsIDOMWindowUtils);
  },

  receiveMessage: function(aMessage) {
    switch(aMessage.name) {
      case "DOMFullscreen:Entered": {
        if (!this._windowUtils.handleFullscreenRequests() &&
            !content.document.mozFullScreen) {
          // If we don't actually have any pending fullscreen request
          // to handle, neither we have been in fullscreen, tell the
          // parent to just exit.
          sendAsyncMessage("DOMFullscreen:Exit");
        }
        break;
      }
      case "DOMFullscreen:CleanUp": {
        this._windowUtils.exitFullscreen();
        this._fullscreenDoc = null;
        break;
      }
    }
  },

  handleEvent: function(aEvent) {
    switch (aEvent.type) {
      case "MozDOMFullscreen:Request": {
        sendAsyncMessage("DOMFullscreen:Request");
        break;
      }
      case "MozDOMFullscreen:NewOrigin": {
        this._fullscreenDoc = aEvent.target;
        sendAsyncMessage("DOMFullscreen:NewOrigin", {
          originNoSuffix: this._fullscreenDoc.nodePrincipal.originNoSuffix,
        });
        break;
      }
      case "MozDOMFullscreen:Exit": {
        sendAsyncMessage("DOMFullscreen:Exit");
        break;
      }
      case "MozDOMFullscreen:Entered":
      case "MozDOMFullscreen:Exited": {
        addEventListener("MozAfterPaint", this);
        if (!content || !content.document.mozFullScreen) {
          // If we receive any fullscreen change event, and find we are
          // actually not in fullscreen, also ask the parent to exit to
          // ensure that the parent always exits fullscreen when we do.
          sendAsyncMessage("DOMFullscreen:Exit");
        }
        break;
      }
      case "MozAfterPaint": {
        removeEventListener("MozAfterPaint", this);
        sendAsyncMessage("DOMFullscreen:Painted");
        break;
      }
    }
  }
};
DOMFullscreenHandler.init();

ExtensionContent.init(this);
addEventListener("unload", () => {
  ExtensionContent.uninit(this);
});
