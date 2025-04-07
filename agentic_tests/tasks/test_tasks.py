# File: agentic-tests/test_tasks.py
from crewai import Task
from crewai_tools import FileReadTool
from ..agents.test_agents import test_agents


# === TEXT EXPENSE LOGGING ===
text_expense_logging_task = Task(
    description="Simulate user sending: 'just got $17.50 of nails and glue from Home Depot today'.",
    expected_output="Row with $17.50, items 'nails and glue', vendor 'Home Depot', correct date.",
    tools=[FileReadTool()],
    agent=test_agents["expense_logger_agent"]
)

# === IMAGE EXPENSE LOGGING ===
image_expense_parsing_task = Task(
    description="User sends receipt image from RONA for $48.00. Check Document AI parsing + logging.",
    expected_output="Parsed $48.00, vendor RONA, correct date.",
    tools=[],
    agent=test_agents["expense_logger_agent"]
)

# === VOICE EXPENSE LOGGING ===
voice_expense_parsing_task = Task(
    description="User voice note: 'Spent $95 on roofing nails and tar from Roofmart yesterday'.",
    expected_output="Parsed $95, vendor Roofmart, items 'roofing nails and tar', correct date.",
    tools=[],
    agent=test_agents["voice_parser_agent"]
)

# === ONBOARDING FLOW ===
onboarding_flow_task = Task(
    description="Simulate first-time user. Verify onboarding trigger + spreadsheet creation.",
    expected_output="Bot should ask for job name and create spreadsheet.",
    tools=[],
    agent=test_agents["onboarding_agent"]
)

# === QUOTE GENERATION ===
quote_generation_task = Task(
    description="User says: 'I need a quote for 15 bundles of shingles and 10 rolls of underlayment.'",
    expected_output="AI calculates pricing, formats PDF quote, and confirms details via chat.",
    tools=[],
    agent=test_agents["quote_agent"]
)

# === TASK STATUS UPDATE ===
task_status_tracking_task = Task(
    description="User says: 'Mark roof tear-off as complete and send status update to team.'",
    expected_output="Task status updated. Team notified via WhatsApp webhook.",
    tools=[],
    agent=test_agents["task_manager"]
)
