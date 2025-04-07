# File: agentic_tests/agents/test_agents.py
from crewai import Agent
from dotenv import load_dotenv
import os

load_dotenv()

# === EXPENSE LOGGER AGENT ===
expense_logger_agent = Agent(
    role="Expense Logger",
    goal="Ensure all user-submitted expenses (text/image) are parsed and logged correctly to the spreadsheet.",
    backstory="A diligent assistant focused on logging accurate financial data for users.",
    verbose=True
)

# === VOICE PARSER AGENT ===
voice_parser_agent = Agent(
    role="Voice Note Interpreter",
    goal="Transcribe and parse WhatsApp voice notes into structured expense data.",
    backstory="Trained to extract financial details from speech and convert them into accurate spreadsheet rows.",
    verbose=True
)

# === ONBOARDING AGENT ===
onboarding_agent = Agent(
    role="Onboarding Guide",
    goal="Greet new users and guide them through setting up their first spreadsheet.",
    backstory="A friendly onboarding AI that ensures every user starts off successfully.",
    verbose=True
)

# === QUOTE GENERATION AGENT ===
quote_agent = Agent(
    role="Quote Generator",
    goal="Receive material quantity inputs and calculate total project quotes.",
    backstory="An estimating AI that formats pricing into professional PDF quotes.",
    verbose=True
)

# === TASK MANAGER AGENT ===
task_manager = Agent(
    role="Task Status Manager",
    goal="Track, update, and broadcast progress on active jobs or tasks.",
    backstory="Keeps teams informed and task statuses synced.",
    verbose=True
)

# === COLLECTIVE EXPORT ===
test_agents = {
    "expense_logger_agent": expense_logger_agent,
    "voice_parser_agent": voice_parser_agent,
    "onboarding_agent": onboarding_agent,
    "quote_agent": quote_agent,
    "task_manager": task_manager
}
