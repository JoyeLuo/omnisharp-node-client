import {Observable, Subject, AsyncSubject, BehaviorSubject, Scheduler, CompositeDisposable} from "rx";
import {extend, isObject, some, uniqueId, isArray, each, intersection, keys, filter, isNumber, has, get, set, defaults} from "lodash";
import {IDriver, IStaticDriver, IDriverOptions, OmnisharpClientStatus, OmnisharpClientOptions} from "../interfaces";
import {Driver, DriverState} from "../enums";
import {RequestContext, ResponseContext, CommandContext} from "./contexts";
import {serverLineNumbers, serverLineNumberArrays} from "./response-handling";

(function() {
    // Temp code, remove with 4.0.0
    var Rx = require('rx');
    Rx.Observable.prototype.flatMapWithMaxConcurrent = function(limit, selector, resultSelector, thisArg) {
        return new Rx.FlatMapObservable(this, selector, resultSelector, thisArg).merge(limit);
    };
var FlatMapObservable = Rx.FlatMapObservable = (function(__super__) {

    Rx.internals.inherits(FlatMapObservable, __super__);

    function FlatMapObservable(source, selector, resultSelector, thisArg) {
      this.resultSelector = Rx.helpers.isFunction(resultSelector) ? resultSelector : null;
      this.selector = Rx.internals.bindCallback(Rx.helpers.isFunction(selector) ? selector : function() { return selector; }, thisArg, 3);
      this.source = source;
      __super__.call(this);
    }

    FlatMapObservable.prototype.subscribeCore = function(o) {
      return this.source.subscribe(new InnerObserver(o, this.selector, this.resultSelector, this));
    };

    Rx.internals.inherits(InnerObserver, Rx.internals.AbstractObserver);
    function InnerObserver(observer, selector, resultSelector, source) {
      this.i = 0;
      this.selector = selector;
      this.resultSelector = resultSelector;
      this.source = source;
      this.o = observer;
      Rx.internals.AbstractObserver.call(this);
    }

    InnerObserver.prototype._wrapResult = function(result, x, i) {
      return this.resultSelector ?
        result.map(function(y, i2) { return this.resultSelector(x, y, i, i2); }, this) :
        result;
    };

    InnerObserver.prototype.next = function(x) {
      var i = this.i++;
      var result = Rx.internals.tryCatch(this.selector)(x, i, this.source);
      //if (result === errorObj) { return this.o.onError(result.e); }

      Rx.helpers.isPromise(result) && (result = Rx.Observable.fromPromise(result));
      (Rx.helpers.isArrayLike(result) || Rx.helpers.isIterable(result)) && (result = Rx.Observable.from(result));
      this.o.onNext(this._wrapResult(result, x, i));
    };

    InnerObserver.prototype.error = function(e) { this.o.onError(e); };

    InnerObserver.prototype.onCompleted = function() { this.o.onCompleted(); };

    return FlatMapObservable;

}(Rx.ObservableBase));
})();


var {isPriorityCommand, isNormalCommand, isDeferredCommand} = (function() {
    var normalCommands = [
        'findimplementations', 'findsymbols', 'findusages',
        'gotodefinition', 'typelookup', 'navigateup',
        'navigatedown', 'getcodeactions', 'filesChanged',
        'runcodeaction', 'autocomplete', 'signatureHelp'
    ];
    var priorityCommands = [
        'updatebuffer', 'changebuffer', 'formatAfterKeystroke'
    ];

    var prioritySet = new Set<string>();
    var normalSet = new Set<string>();
    var deferredSet = new Set<string>();
    var undeferredSet = new Set<string>();

    each(normalCommands, x => {
        normalSet.add(x);
        undeferredSet.add(x);
    });

    each(priorityCommands, x => {
        prioritySet.add(x);
        undeferredSet.add(x);
    });

    var isPriorityCommand = (request: RequestContext<any>) => prioritySet.has(request.command);
    var isNormalCommand = (request: RequestContext<any>) => normalSet.has(request.command);

    function isDeferredCommand(request: RequestContext<any>) {
        if (request.silent && !isPriorityCommand(request)) {
            return true;
        }

        if (deferredSet.has(request.command)) {
            return true;
        }

        if (undeferredSet.has(request.command)) {
            return false;
        }

        deferredSet.add(request.command);
        return true;
    }

    return { isPriorityCommand, isNormalCommand, isDeferredCommand };
})()


function flattenArguments(obj, prefix = '') {
    var result: any[] = [];
    each(obj, (value, key) => {
        if (isObject(value)) {
            result.push(...flattenArguments(value, `${prefix ? prefix + ':' : ''}${key[0].toUpperCase() + key.substr(1) }`));
            return
        }

        result.push(`--${prefix ? prefix + ':' : ''}${key[0].toUpperCase() + key.substr(1) }=${value}`);
    });

    return result;
}

export class ClientBase implements IDriver, OmniSharp.Events, Rx.IDisposable {
    private _driver: IDriver;
    private _requestStream = new Subject<RequestContext<any>>();
    private _responseStream = new Subject<ResponseContext<any, any>>();
    private _statusStream: Rx.Observable<OmnisharpClientStatus>;
    private _errorStream = new Subject<CommandContext<any>>();
    private _customEvents = new Subject<OmniSharp.Stdio.Protocol.EventPacket>();
    private _uniqueId = uniqueId("client");
    protected _lowestIndexValue: number;
    private _eventWatchers = new Map<string, Subject<CommandContext<any>>>();
    private _commandWatchers = new Map<string, Subject<ResponseContext<any, any>>>();
    private _disposable = new CompositeDisposable();

    public static fromClient<T extends ClientBase>(ctor: any, client: ClientBase) {
        var v1: ClientBase = <any>new ctor(client._options);

        v1._driver = client._driver;
        v1._requestStream = client._requestStream;
        v1._responseStream = client._responseStream;
        v1._statusStream = client._statusStream;
        v1._errorStream = client._errorStream;
        v1._customEvents = client._customEvents;
        v1._uniqueId = client._uniqueId;
        v1._disposable = client._disposable;

        v1.setupObservers();

        return <T>v1;
    }

    public get uniqueId() { return this._uniqueId; }

    public get id() { return this._driver.id; }
    public get serverPath() { return this._driver.serverPath; }
    public get projectPath() { return this._driver.projectPath; }

    public get currentState() { return this._driver.currentState; }
    private _enqueuedEvents: Rx.Observable<OmniSharp.Stdio.Protocol.EventPacket>;
    public get events(): Rx.Observable<OmniSharp.Stdio.Protocol.EventPacket> { return this._enqueuedEvents; }
    public get commands(): Rx.Observable<OmniSharp.Stdio.Protocol.ResponsePacket> { return this._driver.commands; }
    public get state(): Rx.Observable<DriverState> { return this._driver.state; }
    public get outstandingRequests() { return this._driver.outstandingRequests; }

    public get status(): Rx.Observable<OmnisharpClientStatus> { return this._statusStream; }
    public get requests(): Rx.Observable<RequestContext<any>> { return this._requestStream; }

    private _enqueuedResponses: Rx.Observable<ResponseContext<any, any>>;
    public get responses(): Rx.Observable<ResponseContext<any, any>> { return this._enqueuedResponses; }
    public get errors(): Rx.Observable<CommandContext<any>> { return this._errorStream; }

    constructor(private _options: OmnisharpClientOptions = {}) {
        var driver = _options.driver || Driver.Stdio;
        var statusSampleTime = _options.statusSampleTime || (_options.statusSampleTime = 500);
        var responseSampleTime = _options.responseSampleTime || (_options.responseSampleTime = 100);
        var responseConcurrency = _options.concurrency || (_options.concurrency = 4);

        _options.additionalArguments = flattenArguments(_options.omnisharp || {});

        var driverFactory: IStaticDriver = require('../drivers/' + Driver[driver].toLowerCase());
        this._driver = new driverFactory(_options);

        this._disposable.add(this._driver);
        this._disposable.add(this._requestStream);
        this._disposable.add(this._responseStream);
        this._disposable.add(this._errorStream);
        this._disposable.add(this._customEvents);

        this._enqueuedEvents = Observable.merge(this._customEvents, this._driver.events)
            .map(event => {
                if (isObject(event.Body)) {
                    Object.freeze(event.Body);
                }
                return Object.freeze(event);
            });

        this._enqueuedResponses = Observable.merge(
            this._responseStream,
            this._driver.commands
                .map(packet => new ResponseContext(new RequestContext(this._uniqueId, packet.Command, {}, {}, 'command'), packet.Body)));

        this._lowestIndexValue = _options.oneBasedIndices ? 1 : 0;

        var getStatusValues = () => <OmnisharpClientStatus>({
            state: this._driver.currentState,
            outgoingRequests: this._driver.outstandingRequests,
            hasOutgoingRequests: this._driver.outstandingRequests > 0
        });

        var status = Observable.merge(<Observable<any>>this._requestStream, <Observable<any>>this._responseStream)
            .map(() => getStatusValues());
        var tstatus = status.throttle(statusSampleTime).share();

        this._statusStream = Observable.merge(status, tstatus)
            .buffer(tstatus, () => Observable.timer(statusSampleTime))
            .map(x => x.length > 0 ? (x[x.length - 1]) : getStatusValues())
            .distinctUntilChanged()
            .map(Object.freeze)
            .share();

        if (this._options.debug) {
            this._disposable.add(this._responseStream.subscribe(Context => {
                // log our complete response time
                this._customEvents.onNext({
                    Event: "log",
                    Body: {
                        Message: `/${Context.command}  ${Context.responseTime}ms (round trip)`,
                        LogLevel: "INFORMATION"
                    },
                    Seq: -1,
                    Type: "log"
                })
            }));
        }

        this.setupRequestStreams();
        this.setupObservers();
    }

    public dispose() {
        if (this._disposable.isDisposed) return;
        this.disconnect();
        this._disposable.dispose();
    }

    private setupRequestStreams() {
        var priorityRequests = new BehaviorSubject(0), priorityResponses = new BehaviorSubject(0);

        var pauser = Observable.combineLatest(
            priorityRequests,
            priorityResponses,
            (requests, responses) => {
                if (requests > 0 && responses === requests) {
                    priorityRequests.onNext(0);
                    priorityResponses.onNext(0);
                    return true;
                } else if (requests > 0) {
                    return false;
                }

                return true;
            })
            .startWith(true)
            .debounce(120);

        // These are operations that should wait until after
        // we have executed all the current priority commands
        // We also defer silent commands to this queue, as they are generally for "background" work
        var deferredQueue = this._requestStream
            .where(isDeferredCommand)
            .pausableBuffered(pauser)
            .flatMapWithMaxConcurrent(1, request => this.handleResult(request))
            .subscribe();

        // We just pass these operations through as soon as possible
        var normalQueue = this._requestStream
            .where(isNormalCommand)
            .pausableBuffered(pauser)
            .flatMapWithMaxConcurrent(this._options.concurrency, request => this.handleResult(request))
            .subscribe();

        // We must wait for these commands
        // And these commands must run in order.
        var priorityQueue = this._requestStream
            .where(isPriorityCommand)
            .doOnNext(() => priorityRequests.onNext(priorityRequests.getValue() + 1))
            .controlled();

        priorityQueue
            .map(request => this.handleResult(request))
            .subscribe(response => {
                response
                    .subscribeOnCompleted(() => {
                        priorityResponses.onNext(priorityResponses.getValue() + 1)
                        priorityQueue.request(1);
                    });
            });

        // We need to have a pending request to catch the first one coming in.
        priorityQueue.request(1);
    }

    private handleResult(context: RequestContext<any>) {
        var result = this._driver.request<any, any>(context.command, context.request);

        result.subscribe((data) => {
            this._responseStream.onNext(new ResponseContext(context, data));
        }, (error) => {
            this._errorStream.onNext(new CommandContext(context.command, error));
        });

        return result;
    }

    public static serverLineNumbers = serverLineNumbers;
    public static serverLineNumberArrays = serverLineNumberArrays;

    public log(message: string, logLevel?: string) {
        // log our complete response time
        this._customEvents.onNext({
            Event: "log",
            Body: {
                Message: message,
                LogLevel: logLevel ? logLevel.toUpperCase() : "INFORMATION"
            },
            Seq: -1,
            Type: "log"
        });
    }

    public connect(_options?: OmnisharpClientOptions) {
        // There is no return from error for this client
        //if (this.currentState === DriverState.Error) return;
        if (this.currentState === DriverState.Connected || this.currentState === DriverState.Connecting) return;

        if (_options && _options.omnisharp) {
            _options.additionalArguments = flattenArguments(_options.omnisharp || {});
        }

        var driver = this._options.driver;
        extend(this._options, _options || {});
        this._options.driver = driver;
        this._driver.connect(this._options);
    }

    public disconnect() {
        this._driver.disconnect();
    }

    public request<TRequest, TResponse>(action: string, request: TRequest, options?: OmniSharp.RequestOptions): Rx.Observable<TResponse> {
        if (!options) options = <OmniSharp.RequestOptions>{};
        defaults(options, { oneBasedIndices: this._options.oneBasedIndices });

        // Handle disconnected requests
        if (this.currentState !== DriverState.Connected && this.currentState !== DriverState.Error) {
            var response = new AsyncSubject<TResponse>();

            var sub = this.state.where(z => z === DriverState.Connected).subscribe(z => {
                sub.dispose();
                this.request<TRequest, TResponse>(action, request, options).subscribe(z => response.onNext(z));
            });

            return response;
        }

        var Context = new RequestContext(this._uniqueId, action, request, options);
        this._requestStream.onNext(Context);

        return Context.getResponse<TResponse>(this._responseStream);
    }

    protected setupObservers() {
        this._driver.events.subscribe(x => {
            if (this._eventWatchers.has(x.Event))
                this._eventWatchers.get(x.Event).onNext(x.Body);
        });

        this._enqueuedResponses.subscribe(x => {
            if (!x.silent && this._commandWatchers.has(x.command))
                this._commandWatchers.get(x.command).onNext(x);
        });

        this.projectAdded = this.watchEvent<OmniSharp.Models.ProjectInformationResponse>("ProjectAdded");
        this.projectChanged = this.watchEvent<OmniSharp.Models.ProjectInformationResponse>("ProjectChanged");
        this.projectRemoved = this.watchEvent<OmniSharp.Models.ProjectInformationResponse>("ProjectRemoved");
        this.error = this.watchEvent<OmniSharp.Models.ErrorMessage>("ProjectRemoved");
        this.msBuildProjectDiagnostics = this.watchEvent<OmniSharp.Models.MSBuildProjectDiagnostics>("MsBuildProjectDiagnostics");
        this.packageRestoreStarted = this.watchEvent<OmniSharp.Models.PackageRestoreMessage>("PackageRestoreStarted");
        this.packageRestoreFinished = this.watchEvent<OmniSharp.Models.PackageRestoreMessage>("PackageRestoreFinished");
        this.unresolvedDependencies = this.watchEvent<OmniSharp.Models.UnresolvedDependenciesMessage>("UnresolvedDependencies");
    }

    protected watchEvent<TBody>(event: string): Observable<TBody> {
        var subject = new Subject<CommandContext<any>>();
        this._eventWatchers.set(event, subject);
        this._disposable.add(subject);
        return <any>subject.asObservable().share();
    }

    protected watchCommand(command: string): Observable<OmniSharp.Context<any, any>> {
        var subject = new Subject<ResponseContext<any, any>>();
        this._commandWatchers.set(command, subject);
        this._disposable.add(subject);
        return subject.asObservable().share();
    }

    public projectAdded: Rx.Observable<OmniSharp.Models.ProjectInformationResponse>;
    public projectChanged: Rx.Observable<OmniSharp.Models.ProjectInformationResponse>;
    public projectRemoved: Rx.Observable<OmniSharp.Models.ProjectInformationResponse>;
    public error: Rx.Observable<OmniSharp.Models.ErrorMessage>;
    public msBuildProjectDiagnostics: Rx.Observable<OmniSharp.Models.MSBuildProjectDiagnostics>;
    public packageRestoreStarted: Rx.Observable<OmniSharp.Models.PackageRestoreMessage>;
    public packageRestoreFinished: Rx.Observable<OmniSharp.Models.PackageRestoreMessage>;
    public unresolvedDependencies: Rx.Observable<OmniSharp.Models.UnresolvedDependenciesMessage>;

}
