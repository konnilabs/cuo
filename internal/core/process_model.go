package core

// Snapshots survive container replacement and log retention.
type ContainerSnapshot struct {
	EngineID string `json:"engineId"`
	Name     string `json:"name"`
	Image    string `json:"image"`
	ImageID  string `json:"imageId"`
	State    string `json:"state"`
	Platform string `json:"platform"`
	Managed  bool   `json:"managed"`
}
type StageTiming struct {
	Stage      string `json:"stage"`
	Started    string `json:"startedAt"`
	Finished   string `json:"finishedAt,omitempty"`
	DurationMS int64  `json:"durationMs"`
}
type ProcessAnomaly struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}
type ProcessRun struct {
	LogsPruned         bool             `json:"logsPruned,omitempty"`
	Stages             []StageTiming    `json:"stages,omitempty"`
	Names              []string         `json:"containerNames,omitempty"`
	ID                 string           `json:"id"`
	Kind               string           `json:"kind"`
	Name               string           `json:"name"`
	State              string           `json:"state"`
	Created            string           `json:"createdAt"`
	Started            string           `json:"startedAt,omitempty"`
	Finished           string           `json:"finishedAt,omitempty"`
	NextStart          string           `json:"nextStart,omitempty"`
	DurationMS         int64            `json:"durationMs"`
	QueueMS            int64            `json:"queueMs"`
	BaselineMS         int64            `json:"baselineMs"`
	BaselineSamples    int              `json:"baselineSamples"`
	ContainerCount     int              `json:"containerCount"`
	Succeeded          int              `json:"succeeded"`
	Failed             int              `json:"failed"`
	Pending            int              `json:"pending"`
	JobIDs             []string         `json:"jobIds"`
	ContainerIDs       []string         `json:"containerIds"`
	Anomalies          []ProcessAnomaly `json:"anomalies"`
	Reason             string           `json:"reason"`
	Requester          string           `json:"requester"`
	WindowID           string           `json:"windowId,omitempty"`
	Skipped            []RunSkip        `json:"skipped"`
	TelemetryAvailable bool             `json:"telemetryAvailable"`
}
type ProcessDetail struct {
	Run         ProcessRun `json:"run"`
	Jobs        []Job      `json:"jobs"`
	Events      []Event    `json:"events"`
	EventCount  int        `json:"eventCount"`
	NextEventID int64      `json:"nextEventId"`
	MoreEvents  bool       `json:"moreEvents"`
	LogsPruned  bool       `json:"logsPruned"`
}
type LogRetention struct {
	Revision      int    `json:"revision"`
	Enabled       bool   `json:"enabled"`
	Days          int    `json:"days"`
	MaxEvents     int    `json:"maxEvents"`
	IntervalHours int    `json:"intervalHours"`
	LastRun       string `json:"lastRun,omitempty"`
	LastDeleted   int64  `json:"lastDeleted"`
}
type LogStorage struct {
	Policy        LogRetention `json:"policy"`
	Events        int64        `json:"events"`
	DatabaseBytes int64        `json:"databaseBytes"`
	ReusableBytes int64        `json:"reusableBytes"`
	ActiveJobs    int          `json:"activeJobs"`
}
type LogMaintenanceRequest struct {
	Revision      int    `json:"revision,omitempty"`
	Enabled       bool   `json:"enabled,omitempty"`
	Days          int    `json:"days,omitempty"`
	MaxEvents     int    `json:"maxEvents,omitempty"`
	IntervalHours int    `json:"intervalHours,omitempty"`
	Reason        string `json:"reason"`
	Confirmed     bool   `json:"confirmed"`
	Confirmation  string `json:"confirmation,omitempty"`
}
type LogMaintenanceResult struct {
	Deleted       int64 `json:"deleted"`
	ProtectedJobs int   `json:"protectedJobs"`
	Compacted     bool  `json:"compacted"`
}
type DataExport struct {
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Content     string `json:"content"`
	Rows        int    `json:"rows"`
	Generated   string `json:"generatedAt"`
}

type ProcessPage struct {
	Items    []ProcessRun `json:"items"`
	Upcoming []ProcessRun `json:"upcoming"`
	Total    int          `json:"total"`
	Offset   int          `json:"offset"`
	Limit    int          `json:"limit"`
}
