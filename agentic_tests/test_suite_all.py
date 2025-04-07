from dotenv import load_dotenv
import os
load_dotenv()
print("OPENAI_API_KEY from env:", os.getenv("OPENAI_API_KEY"))
from crewai import Task, Crew
from agentic_tests.agents.test_agents import test_agents
from crewai_tools import FileReadTool
import os


# Define tasks to test key features
text_expense_test = Task(
    description="Simulate user sending: 'just got $17.50 of nails and glue from Home Depot today'. Check if the spreadsheet logs this correctly.",
    expected_output="A new row should be created with amount $17.50, items 'nails and glue', vendor 'Home Depot', and correct date.",
    tools=[FileReadTool()],
    agent=test_agents["expense_logger_agent"]
)

image_expense_test = Task(
    description="Simulate user uploading an image of a receipt from RONA for $48.00. Check parsing and spreadsheet logging accuracy.",
    expected_output="A row is created with amount $48.00, correct date and vendor = RONA, pulled from the image using Document AI.",
    tools=[],
    agent=test_agents["expense_logger_agent"]
)

voice_expense_test = Task(
    description="Simulate a user sending a WhatsApp voice note that says: 'Spent $95 on roofing nails and tar from Roofmart yesterday'. Check transcription and spreadsheet logging.",
    expected_output="Parsed result should show $95, items: 'roofing nails and tar', vendor: 'Roofmart', date: yesterday's date.",
    tools=[],
    agent=test_agents["voice_parser_agent"]
)

onboarding_test = Task(
    description="Simulate a first-time user message. Verify if onboarding is triggered and a new spreadsheet is created.",
    expected_output="Assistant should welcome the user, ask for job name, and create a new Google Sheet for expense logging.",
    tools=[],
    agent=test_agents["onboarding_agent"]
)

# Combine tasks into a single test crew
test_suite = Crew(
    agents=list(test_agents.values()),
    tasks=[
        text_expense_test,
        image_expense_test,
        voice_expense_test,
        onboarding_test
    ],
    verbose=True
)

if __name__ == "__main__":
    results = test_suite.kickoff()
    print("\n✅ Test Results:")
    print(results)
