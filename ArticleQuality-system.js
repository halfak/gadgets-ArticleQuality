mw.loader.using(['mediawiki.api']).done(
(function($, mw){
	var defaultOptions = {
		parameters: {
			format: 'json'
		},
		ajax: {
			timeout: 30 * 1000, // 30 seconds
			dataType: 'json',
			type: 'GET'
		},
		score: {
			batchSize: 50,
			maxWorkers: 4
		}
	};

	/**
	 * Constructor to create a pool of workers to request a set of model-scores
	 * from the ORES api.  This object will allow scoring jobs to be
	 * transparently started within a worker pool.  The worker pool will then
	 * manage all requests in order to comply with the options provided
	 * (e.g. batchSize and maxWorkers).
	 *
	 *     var ores = require('ext.ores.api');
	 *     aqPool = ores.Pool([ "articlequality" ], {batchSize: 50, maxWorkers: 3})
	 *
	 *     aqPool.score(214412)
	 *       .done(function(scoreDoc){...})
	 *     aqPool.score(214413)
	 *       .done(function(scoreDoc){...})
	 *
	 * @constructor
	 * @param {Object} [oresApi] An OresApi object to use for querying
	 * @param {Array} [models] A list of models to query for in each request
	 * @param {Object} [options] A set of options for querying.  See defaultOptions.score above
	 */
	var OresScoreBatcherPool = function(oresApi, models, options) {
		this.oresApi = oresApi;
		this.models = models;
		this.batchSize = options.batchSize || defaultOptions.score.batchSize;
		this.maxWorkers = options.maxWorkers || defaultOptions.score.maxWorkers;
		this.liveWorkers = 0;
		this.taskQueue = [];
		this.tasksQueued = $.Deferred()
			.progress(this.ensureWorkers.bind(this));
	};
	OresScoreBatcherPool.prototype = {
		/**
		 * Add a score job to the queue and return a promise for the result.
		 *
		 * @param {number} [revId] A revision to score with the given model
		 */
		score: function(revId) {
			var resultDfd = $.Deferred(),
				task = {revId: revId, resultDfd: resultDfd};

			this.taskQueue.push(task);
			this.tasksQueued.notify();
			return resultDfd.promise();
		},
		/**
		 * Process a batch and recurse until the taskQueue is empty
		 */
		processTaskBatches: function(){
			// Get a batch to process
			batch = this.taskQueue.splice(0, this.batchSize);

			// If there's stuff to process, start a new score batch processing job and
			// recurse when it finishes.
			if (batch.length) {
				this.scoreBatch(batch)
					.fail(function(){
						for (var i = 0; i < batch.length; i++) {
							batch[i].resultDfd.error.apply(null, arguments);
						}
					})
					.always(this.processTaskBatches.bind(this));
			} else {
				// shut down worker and decrement the worker count
				this.liveWorkers -= 1;
				console.debug("Shutting down worker");
			}
		},
		/**
		 * Generate a set of scores for a batch.  Results will be sent to specific
		 * deferred result objects.
		 */
		scoreBatch: function(batch){
			var batchDfd = $.Deferred(),
				revIds = [];

			for (var i = 0; i < batch.length; i++) {
				revIds.push(batch[i].revId);
			}

			this.oresApi.get({revids: revIds, models: this.models})
				.done(function(responseDoc){
					for (var i = 0; i < batch.length; i++) {
						var scoreDoc = responseDoc[this.oresApi.options.dbname].scores[batch[i].revId];
						batch[i].resultDfd.resolve(scoreDoc);
					}
				}.bind(this))
				.fail(function(){
					for (var i = 0; i < batch.length; i++) {
						batch[i].resultDfd.error.apply(null, arguments);
					}
				})
				.always(function(){batchDfd.resolve()});

			return batchDfd.promise();
		},
		/**
		 * Ensure that workers are running.  This method is used when a task is
		 * added to the queue to make sure that the workers are started/restarted
		 * if necessary.  Note that a 50ms delay is implemented for starting a
		 * worker process to ensure that tasks are given enough time to enqueue
		 * before batch processing starts.
		 */
		ensureWorkers: function(){
			while (this.liveWorkers < this.maxWorkers) {
				console.debug("Starting up worker");
				setTimeout(
					function(){this.processTaskBatches()}.bind(this),
					50);
				this.liveWorkers += 1;
			}
		}
	};

	/**
	 * Constructor to create an object to interact with the API of an ORES server.
	 * OresApi objects represent the API of a particular ORES server.
	 *
	 *     var ores = require('ext.ores.api');
	 *     ores.get( {
	 *         revids: [1234, 1235],
	 *         models: [ 'damaging', 'articlequality' ] // same effect as 'damaging|articlequality'
	 *     } ).done( function ( data ) {
	 *         console.log( data );
	 *     } );
	 *
	 * @constructor
	 * @param {Object} [options] See #defaultOptions documentation above.
	 */
	var OresApi = function ( options ) {

		options.parameters = $.extend( {}, defaultOptions.parameters, options.parameters );
		options.ajax = $.extend( {}, defaultOptions.ajax, options.ajax );
		options.score = $.extend( {}, defaultOptions.score, options.score );

		if ( options.ajax.url ) {
			options.ajax.url = String( options.ajax.url );
		} else {
			options.ajax.url = options.host + '/v3/scores/' + options.dbname;
		}

		this.options = options;
		this.requests = [];
	};

	OresApi.prototype = {
		/**
		 * Abort all unfinished requests issued by this Api object.
		 *
		 * @method
		 */
		abort: function () {
			this.requests.forEach( function ( request ) {
				if ( request ) {
					request.abort();
				}
			} );
		},

		/**
		 * Massage parameters from the nice format we accept into a format suitable for the API.
		 *
		 * @private
		 * @param {Object} parameters (modified in-place)
		 */
		preprocessParameters: function ( parameters ) {
			var key;
			for ( key in parameters ) {
				if ( Array.isArray( parameters[ key ] ) ) {
					parameters[ key ] = parameters[ key ].join( '|' );
				} else if ( parameters[ key ] === false || parameters[ key ] === undefined ) {
					// Boolean values are only false when not given at all
					delete parameters[ key ];
				}
			}
		},

		/**
		 * Perform an API call.
		 *
		 * @param {Object} parameters
		 * @return {jQuery.Promise} Done: API response data and the jqXHR object.
		 *  Fail: Error code
		 */
		get: function ( parameters ) {
			var requestIndex,
				api = this,
				apiDeferred = $.Deferred(),
				xhr,
				ajaxOptions;

			parameters = $.extend( {}, this.options.parameters, parameters );
			ajaxOptions = $.extend( {}, this.options.ajax );

			this.preprocessParameters( parameters );

			ajaxOptions.data = $.param( parameters );

			xhr = $.ajax( ajaxOptions )
				.done( function ( result, textStatus, jqXHR ) {
					var code;
					if ( result.error ) {
						code = result.error.code === undefined ? 'unknown' : result.error.code;
						apiDeferred.reject( code, result, jqXHR );
					} else {
						apiDeferred.resolve( result, jqXHR );
					}
				} );

			requestIndex = this.requests.length;
			this.requests.push( xhr );
			xhr.always( function () {
				api.requests[ requestIndex ] = null;
			} );
			return apiDeferred.promise( { abort: xhr.abort } ).fail( function ( code, details ) {
				if ( !( code === 'http' && details && details.textStatus === 'abort' ) ) {
					mw.log( 'OresApi error: ', code, details );
				}
			} );
		},
		/**
		 * Create a new OresScoreBatcherPool using this api session.
		 *
		 * @param {Array} [models] A list of models to query for in each request
		 * @param {Object} [options] A set of options for querying.  See defaultOptions.score above
		 */
		pool: function(models, options){
			return new OresScoreBatcherPool(this, models, options);
		}
	};

	var ArticleQuality = function(options){
		this.weights = options.weights;
		this.names = options.names;
		this.assessment_system = options.assessment_system;
		this.modelName = options.modelName || "articlequality";

		this.mwApi = new mw.Api();
		this.oresApi = new OresApi({host: options.ores_host, dbname: options.dbname});
		this.aqPool = this.oresApi.pool(this.modelName, {batchSize: 10});
	};
	ArticleQuality.prototype = {
		computeWeightedSum: function(score){
			var clsProba = score.probability;
			var weightedSum = 0;
			for (var cls in clsProba) {
				if (clsProba.hasOwnProperty(cls)) {
					var proba = clsProba[cls];
					weightedSum += proba * this.weights[cls];
				}
			}
			return weightedSum;
		},
		computeWeightedProportion: function(score){
			var weightedSum = this.computeWeightedSum(score);
			return weightedSum / Math.max.apply(null, Object.values(this.weights));
		},
		extractPrediction: function(score){
			return score.prediction;
		},
		parseText: function(text){
			var dfd = jQuery.Deferred();
			this.mwApi.get({action: "parse", text: text, contentmodel: "wikitext", formatversion: 2, prop: "text", disablelimitreport: true})
				.done(function(data){dfd.resolve($(data.parse.text).find('p').html())})
				.fail(function(error){dfd.reject(error)});
			return dfd.promise();
		},
		getCurrentRevId: function(title){
			var dfd = jQuery.Deferred();
			this.mwApi.get({action: 'query', prop: 'revisions', titles: title, rvprop: 'ids', formatversion: 2})
				.done(function(data){dfd.resolve(data.query.pages[0].revisions[0].revid)})
				.fail(function(error){dfd.reject(error)});
			return dfd.promise();
		},
		oresScore: function(revId){
			var dfd = $.Deferred();
			this.aqPool.score(revId)
				.done(function(scoreDoc){dfd.resolve(scoreDoc[this.modelName].score)}.bind(this))
				.fail(function(){dfd.error.apply(null, arguments)});
			return dfd.promise();
		},
		getAndRenderScoreHeader: function(){
			var revId = mw.config.get('wgCurRevisionId');
			this.oresScore(revId)
				.done(this.renderScoreHeader.bind(this))
				.fail(function(error){console.error(error)});
		},
		renderScoreHeader: function(score){
			var rawText = this.formatScoreHeader(score);
			var qualityBlock = $('<div>').addClass("article_quality");
			$('#bodyContent').prepend(qualityBlock);
			this.parseText(rawText)
				.done(function(html){qualityBlock.html(html)})
				.fail(function(error){console.error(error)});
		},
		formatScoreHeader: function(score){
			var prediction = this.extractPrediction(score);
			var weightedSum = this.computeWeightedSum(score);
			return this.assessment_system + ": " +
				this.names[prediction] + " (" +
				Math.round(weightedSum*100)/100 + ")";
		},
		renderScoreLink: function(score, span){
			var prediction = this.extractPrediction(score);
			this.parseText(this.names[prediction])
				.done(function(html){span.prepend(html)})
				.fail(function(error){console.error(error)});
		},
		getAndRenderScoreLink: function(revId, span){
			this.oresScore(revId)
				.done(function(score){this.renderScoreLink(score, span)}.bind(this))
				.fail(function(error){console.error(error)});
		},
		addScoresToArticleLinks: function(){
			$("span.ores-wp10-prediction, span.ores-quality-prediction").each(function(i, element){
				var span = $(element);
				var anchor = span.find('a');
				var pageTitle = anchor.attr('title');
				this.getCurrentRevId(pageTitle)
					.done(function(revId){this.getAndRenderScoreLink(revId, span)}.bind(this))
			    	.fail(function(error){console.error(error)});
			}.bind(this));
		},
		renderHistoryScore: function(li, score){
			var level = Math.round(this.computeWeightedSum(score));
			var weightedProportion = this.computeWeightedProportion(score);
			var qualityPredictionNode = $("<div>").addClass("qualityprediction")
				.addClass("level_" + level)
				.append($("<div>").addClass("bar").css("width", Math.round(weightedProportion*100) + "%").append("&nbsp;"))
				.attr('title', this.formatScoreHeader(score));
			li.prepend(qualityPredictionNode);
		},
		getAndRenderHistoryScore: function(li){
			var revId = li.attr('data-mw-revid');
			this.oresScore(revId)
				.done(function(score){this.renderHistoryScore(li, score)}.bind(this))
				.fail(function(error){console.error(error)});
		},
		getAndRenderHistoryScores: function(){
			var revisionNodes = $('#pagehistory li');
			revisionNodes.each(function(i, element){this.getAndRenderHistoryScore($(element))}.bind(this));
		}
	}
	window.ArticleQuality = ArticleQuality;
})(jQuery, mediaWiki)
);
