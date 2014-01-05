/*!
 * Webogram v0.1 - messaging web application for MTProto
 * https://github.com/zhukov/webogram
 * Copyright (C) 2014 Igor Zhukov <igor.beatle@gmail.com>
 * https://github.com/zhukov/webogram/blob/master/LICENSE
 */

'use strict';

/* Controllers */

angular.module('myApp.controllers', [])

  .controller('AppWelcomeController', function($scope, $location, MtpApiManager) {
    MtpApiManager.getUserID().then(function (id) {
      if (id) {
        $location.path('/im');
      } else {
        $location.path('/login');
      }
    });
  })

  .controller('AppLoginController', function ($scope, $location, MtpApiManager) {
    var dcID = 1;

    $scope.credentials = {};

    function saveAuth (result) {
      MtpApiManager.setUserAuth(dcID, {
        expires: result.expires,
        id: result.user.id
      });

      $location.path('/im');
    };

    $scope.sendCode = function () {
      MtpApiManager.invokeApi('auth.sendCode', {
        phone_number: $scope.credentials.phone_number,
        sms_type: 0,
        api_id: 2496,
        api_hash: '8da85b0d5bfe62527e5b244c209159c3'
      }, {dcID: dcID}).then(function (sentCode) {

        $scope.credentials.phone_code_hash = sentCode.phone_code_hash;
        $scope.credentials.phone_occupied = sentCode.phone_registered;
        $scope.error = {};

      }, function (error) {
        dLog('sendCode', error);
        if (error.code == 303) {
          var newDcID = error.type.match(/^(PHONE_MIGRATE_|NETWORK_MIGRATE_)(\d+)/)[2];
          if (newDcID != dcID) {
            dcID = newDcID;
            $scope.sendCode();
            return;
          }
        }
        switch (error.type) {
          case 'PHONE_NUMBER_INVALID':
            $scope.error = {field: 'phone'};
            break;
        }
      });
    }

    $scope.logIn = function (forceSignUp) {
      var method = 'auth.signIn', params = {
        phone_number: $scope.credentials.phone_number,
        phone_code_hash: $scope.credentials.phone_code_hash,
        phone_code: $scope.credentials.phone_code
      };
      if (forceSignUp) {
        method = 'auth.signUp';
        angular.extend(params, {
          first_name: $scope.credentials.first_name,
          last_name: $scope.credentials.last_name
        });
      }

      MtpApiManager.invokeApi(method, params, {dcID: dcID}).then(saveAuth, function (error) {
        if (error.code == 400 && error.type == 'PHONE_NUMBER_UNOCCUPIED') {
          return $scope.logIn(true);
        } else if (error.code == 400 && error.type == 'PHONE_NUMBER_UNOCCUPIED') {
          return $scope.logIn(false);
        }

        switch (error.type) {
          case 'FIRSTNAME_INVALID':
            $scope.error = {field: 'first_name'};
            break;
          case 'LASTNAME_INVALID':
            $scope.error = {field: 'last_name'};
            break;
          case 'PHONE_CODE_INVALID':
            $scope.error = {field: 'phone_code'};
            break;
        }
      });

    };
  })

  .controller('AppIMController', function ($scope, $location, $routeParams, MtpApiManager) {

    $scope.$on('$routeUpdate', updateCurDialog);

    $scope.isLoggedIn = true;
    $scope.logOut = function () {
      MtpApiManager.logOut().then(function () {
        $location.path('/login');
      });
    }

    updateCurDialog();


    function updateCurDialog() {
      $scope.curDialog = {
        peer: $routeParams.p || false
      };
    }
  })

  .controller('AppImDialogsController', function ($scope, $location, MtpApiManager, AppUsersManager, AppChatsManager, AppMessagesManager, AppPeersManager) {

    $scope.dialogs = [];

    var offset = 0,
        hasMore = false,
        limit = 20;


    MtpApiManager.invokeApi('account.updateStatus', {offline: false});
    $scope.$on('dialogs_need_more', function () {
      showMoreDialogs();
    });

    $scope.$on('dialog_unread', function (e, dialog) {
      angular.forEach($scope.dialogs, function(curDialog) {
        if (curDialog.peerID == dialog.peerID) {
          curDialog.unreadCount = dialog.unread_count;
        }
      });
    });

    $scope.$on('dialogs_update', function (e, dialog) {
      var pos = false;
      angular.forEach($scope.dialogs, function(curDialog, curPos) {
        if (curDialog.peerID == dialog.peerID) {
          pos = curPos;
        }
      });

      var wrappedDialog = AppMessagesManager.wrapForDialog(dialog.top_message, dialog.unread_count);
      if (pos !== false) {
        var prev = $scope.dialogs.splice(pos, 1);
        wrappedDialog = angular.extend(prev[0], wrappedDialog);
        offset++;
      }
      $scope.dialogs.unshift(wrappedDialog);
    });

    loadDialogs();



    function loadDialogs (startLimit) {
      offset = 0;
      hasMore = false;
      startLimit = startLimit || limit;

      AppMessagesManager.getDialogs(offset, startLimit).then(function (dialogsResult) {
        offset += startLimit;
        hasMore = offset < dialogsResult.count;

        $scope.dialogs = [];
        angular.forEach(dialogsResult.dialogs, function (dialog) {
          $scope.dialogs.push(AppMessagesManager.wrapForDialog(dialog.top_message, dialog.unread_count));
        });

        $scope.$broadcast('ui_dialogs_change');
      }, function (error) {
        if (error.code == 401) {
          $location.path('/login');
        }
      });
    }

    function showMoreDialogs () {
      if (!hasMore || !offset) {
        return;
      }

      AppMessagesManager.getDialogs(offset, limit).then(function (dialogsResult) {
        offset += limit;
        hasMore = offset < dialogsResult.count;

        angular.forEach(dialogsResult.dialogs, function (dialog) {
          $scope.dialogs.push(AppMessagesManager.wrapForDialog(dialog.top_message, dialog.unread_count));
        });

        $scope.$broadcast('ui_dialogs_append');
      });
    }

  })

  .controller('AppImHistoryController', function ($scope, $location, $timeout, MtpApiManager, AppUsersManager, AppChatsManager, AppMessagesManager, AppPeersManager, ApiUpdatesManager) {

    $scope.$watch('curDialog.peer', applyDialogSelect);

    ApiUpdatesManager.attach();

    $scope.history = [];
    $scope.typing = {};

    var peerID, offset, hasMore, maxID, limit = 20;

    function applyDialogSelect (newPeer) {
      newPeer = newPeer || $scope.curDialog.peer || '';

      peerID = AppPeersManager.getPeerID(newPeer);

      $scope.curDialog.peerID = peerID;
      $scope.curDialog.inputPeer = AppPeersManager.getInputPeer(newPeer);

      if (peerID) {
        loadHistory(peerID);
      } else {
        showEmptyHistory();
      }
    }

    function showMoreHistory () {
      if (!hasMore || !offset) {
        return;
      }

      console.trace('load history');
      AppMessagesManager.getHistory($scope.curDialog.inputPeer, maxID, limit).then(function (historyResult) {
        offset += limit;
        hasMore = offset < historyResult.count;
        maxID = historyResult.history[historyResult.history.length - 1];

        angular.forEach(historyResult.history, function (id) {
          $scope.history.unshift(AppMessagesManager.wrapForHistory(id));
        });

        $scope.$broadcast('ui_history_prepend');
      }, function () {
        $scope.state = {error: true};
      });
    }

    function loadHistory () {
      hasMore = false;
      offset = 0;
      maxID = 0;

      AppMessagesManager.getHistory($scope.curDialog.inputPeer, maxID, limit).then(function (historyResult) {
        offset += limit;
        hasMore = offset < historyResult.count;
        maxID = historyResult.history[historyResult.history.length - 1];

        $scope.history = [];
        angular.forEach(historyResult.history, function (id) {
          $scope.history.push(AppMessagesManager.wrapForHistory(id));
        });
        $scope.history.reverse();

        $scope.historyPeer = {
          id: peerID,
          data: AppPeersManager.getPeer(peerID),
          photo: AppPeersManager.getPeerPhoto(peerID, 'User', 'Group')
        };

        $scope.typing = {};

        MtpApiManager.getUserID().then(function (id) {
          $scope.ownPhoto = AppUsersManager.getUserPhoto(id, 'User');
        });

        $scope.state = {loaded: true};

        $scope.$broadcast('ui_history_change');

        AppMessagesManager.readHistory($scope.curDialog.inputPeer);
      }, function () {
        $scope.state = {error: true};
      });
    }

    function showEmptyHistory () {
      $scope.state = {notSelected: true};
      $scope.history = [];
    }



    var typingTimeouts = {};

    $scope.$on('history_append', function (e, addedMessage) {
      if (addedMessage.peerID == $scope.curDialog.peerID) {
        dLog('append', addedMessage);
        // console.trace();
        $scope.history.push(AppMessagesManager.wrapForHistory(addedMessage.messageID));
        $scope.typing = {};
        $scope.$broadcast('ui_history_append');
        offset++
      }
    });

    $scope.$on('apiUpdate', function (e, update) {
      // dLog('on apiUpdate inline', update);
      switch (update._) {
        case 'updateUserTyping':
          if (update.user_id == $scope.curDialog.peerID) {
            $scope.typing = {user: AppUsersManager.getUser(update.user_id)};

            $timeout.cancel(typingTimeouts[update.user_id]);

            typingTimeouts[update.user_id] = $timeout(function () {
              $scope.typing = {};
            }, 6000);
          }
          break;

        case 'updateChatUserTyping':
          if (-update.chat_id == $scope.curDialog.peerID) {
            $scope.typing = {user: AppUsersManager.getUser(update.user_id)};

            $timeout.cancel(typingTimeouts[update.user_id]);

            typingTimeouts[update.user_id] = $timeout(function () {
              $scope.typing = {};
            }, 6000);
          }
          break;
      }
    });

    $scope.$on('history_need_more', function () {
      showMoreHistory();
    });

  })

  .controller('AppImPanelController', function($scope) {
    $scope.$on('user_update', angular.noop);
  })

  .controller('AppImSendController', function ($scope, MtpApiManager, AppPeersManager, AppMessagesManager, ApiUpdatesManager, MtpApiFileManager) {

    $scope.$watch('curDialog.peer', resetDraft);
    $scope.$on('user_update', angular.noop);

    $scope.draftMessage = {text: ''};

    var lastTyping = false;
    $scope.$watch('draftMessage.text', function (newVal) {
      AppMessagesManager.readHistory($scope.curDialog.inputPeer);

      var now = +new Date();
      if (newVal === undefined || !newVal.length || now - lastTyping < 6000) {
        return;
      }
      lastTyping = now;

      MtpApiManager.invokeApi('messages.setTyping', {
        peer: $scope.curDialog.inputPeer,
        typing: true
      });
    });

    $scope.sendMessage = sendMessage;

    $scope.$watch('draftMessage.files', onFilesSelected);

    function sendMessage (e) {
      cancelEvent(e);

      var text = $scope.draftMessage.text;

      if ($scope.draftMessage.sending || !text.length) {
        return false;
      }

      text = text.replace(/:\s*(.+?)\s*:/g, function (all, name) {
        var utfChar = $.emojiarea.reverseIcons[name];
        if (utfChar !== undefined) {
          return utfChar;
        }
        return all;
      });

      $scope.draftMessage.sending = true;

      MtpApiManager.invokeApi('messages.sendMessage', {
        peer: $scope.curDialog.inputPeer,
        message: text,
        random_id: $scope.draftMessage.randomID
      }).then(function (result) {

        if (ApiUpdatesManager.saveSeq(result.seq)) {

          MtpApiManager.getUserID().then(function (fromID) {
            ApiUpdatesManager.saveUpdate({
              _: 'updateNewMessage',
              message: {
                _: 'message',
                id: result.id,
                from_id: fromID,
                to_id: AppPeersManager.getOutputPeer($scope.curDialog.peerID),
                out: true,
                unread: true,
                date: result.date,
                message: text,
                media: {_: 'messageMediaEmpty'}
              },
              pts: result.pts
            });
          });

        }

        $scope.$broadcast('ui_message_send');

        resetDraft();
      }, function () {
        delete $scope.draftMessage.sending;
      });

      return cancelEvent(e);
    }


    function resetDraft () {
      $scope.draftMessage = {
        randomID: [nextRandomInt(0xFFFFFFFF), nextRandomInt(0xFFFFFFFF)],
        text: ''
      };
    }

    function onFilesSelected (newVal) {
      if (!angular.isArray(newVal) || !newVal.length) {
        return;
      }

      for (var i = 0; i < newVal.length; i++) {
        (function (file, randomID) {
          MtpApiFileManager.uploadFile(file).then(function (inputFile) {
            var inputMedia;
            if (file.type == 'image/jpeg') {
              inputMedia = {_: 'inputMediaUploadedPhoto', file: inputFile};
            } else {
              inputMedia = {_: 'inputMediaUploadedDocument', file: inputFile, file_name: file.name, mime_type: file.type};
            }
            MtpApiManager.invokeApi('messages.sendMedia', {
              peer: $scope.curDialog.inputPeer,
              media: inputMedia,
              random_id: randomID
            }).then(function (result) {

              if (ApiUpdatesManager.saveSeq(result.seq)) {
                ApiUpdatesManager.saveUpdate({
                  _: 'updateNewMessage',
                  message: result.message,
                  pts: result.pts
                });
              }

              $scope.$broadcast('ui_message_send');
            });
          }, function (error) {
            dLog('upload error', error);
          })

        })(newVal[i], [nextRandomInt(0xFFFFFFFF), nextRandomInt(0xFFFFFFFF)]);
      }
    }

  })

  .controller('PhotoModalController', function ($scope, AppPhotosManager) {
    $scope.photo = AppPhotosManager.wrapForFull($scope.photoID);
  })

  .controller('VideoModalController', function ($scope, AppVideoManager) {
    $scope.video = AppVideoManager.wrapForFull($scope.videoID);
  })

  .controller('UserModalController', function ($scope, $location, AppUsersManager) {
    $scope.user = AppUsersManager.wrapForFull($scope.userID);
    $scope.goToHistory = function () {
      $scope.$close();
      $location.url('/im?p=' + $scope.user.peerString);
    };
  })

  .controller('ChatModalController', function ($scope, AppUsersManager, AppChatsManager, fullChat) {
    $scope.chatFull = AppChatsManager.wrapForFull($scope.chatID, fullChat);
  })


