$.getScript(
	'//meta.wikimedia.org/w/index.php?title=User:EpochFail/ArticleQuality-system.js&action=raw&ctype=text/javascript',
	function(){
		articleQuality = new ArticleQuality({
			ores_host: "https://ores.wikimedia.org",
			weights: {
				E: 1,
				D: 2,
				C: 3,
				B: 4,
				A: 5
			},
			names: {
				E: "E", 
				D: "D",
				C: "C",
				B: "B",
				A: "A"
			},
			assessment_system: "ORES predicted quality",
			dbname: "wikidatawiki",
			modelName: "itemquality"
		});
		if(mw.config.get('wgAction') === "history" && (mw.config.get('wgNamespaceNumber') === 0)){
			articleQuality.getAndRenderHistoryScores();
		}
		if(mw.config.get('wgAction') === "view" && (mw.config.get('wgNamespaceNumber') === 0)){
			articleQuality.getAndRenderScoreHeader();
		}
		articleQuality.addScoresToArticleLinks();
	}
);
importStylesheetURI("//meta.wikimedia.org/w/index.php?title=User:EpochFail/ArticleQuality.css&action=raw&ctype=text/css");
